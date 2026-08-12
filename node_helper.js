/* MagicMirror – MMM-SNCF-Station-Board
 * Backend principal : scrape www.ter.sncf.com via FlareSolverr.
 * Secours : horaires GTFS officiels SNCF publiés par transport.data.gouv.fr.
 */
const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const FLARESOLVERR = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const GTFS_URL = "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip";
const PARIS_TIME_ZONE = "Europe/Paris";

module.exports = NodeHelper.create({
  start() {
    console.log("MMM-SNCF-Station-Board: démarrage (FlareSolverr @ " + FLARESOLVERR + ")");
    this.gtfsCache = null;
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "FETCH_BOARD") {
      this.fetchBoard(payload);
    }
  },

  fetchPage(url, timeoutMs) {
    const body = JSON.stringify({ cmd: "request.get", url, maxTimeout: timeoutMs });
    const parsed = new URL(FLARESOLVERR + "/v1");
    const lib = parsed.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: "/v1",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs + 5000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.status !== "ok") { reject(new Error("FlareSolverr: " + json.message)); return; }
            const html = json.solution.response;
            const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (!m) { reject(new Error("__NEXT_DATA__ introuvable")); return; }
            const page = JSON.parse(m[1]);
            resolve(page.props?.pageProps?.data?.circulations || []);
          } catch (e) {
            reject(new Error("Parse error: " + e.message));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout FlareSolverr")); });
      req.write(body);
      req.end();
    });
  },

  detectStatus(messages) {
    for (const msg of messages || []) {
      const body = (msg.body || "").toLowerCase();
      if (/supprim|annul|ne circule pas|n.effectuera pas/.test(body)) return "cancelled";
      if (/retard|\d+ min/.test(body)) return "delayed";
    }
    return null;
  },

  hhmm(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  },

  csv(zip, filename, onRecord) {
    const entry = zip.getEntry(filename);
    if (!entry) throw new Error(`Fichier GTFS absent : ${filename}`);
    return parse(entry.getData(), {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      on_record: onRecord,
    });
  },

  parisDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: PARIS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  },

  gtfsDates() {
    const now = this.parisDateParts();
    const midnightUtc = Date.UTC(Number(now.year), Number(now.month) - 1, Number(now.day));
    const key = (offset) => {
      const date = new Date(midnightUtc + offset * 86400000);
      return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
    };
    return {
      keys: [key(0), key(1)],
      nowSeconds: Number(now.hour) * 3600 + Number(now.minute) * 60 + Number(now.second),
    };
  },

  gtfsTime(time) {
    const [hours = 0, minutes = 0, seconds = 0] = String(time || "").split(":").map(Number);
    return { seconds: hours * 3600 + minutes * 60 + seconds, display: `${String(hours % 24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}` };
  },

  async loadGtfsSchedule(stationCode) {
    const { keys } = this.gtfsDates();
    const cacheKey = `${stationCode}:${keys.join(":")}`;
    if (this.gtfsCache?.key === cacheKey && this.gtfsCache.expiresAt > Date.now()) {
      return this.gtfsCache.trains;
    }

    const response = await fetch(GTFS_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GTFS SNCF HTTP ${response.status}`);
    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const activeDatesByService = new Map();

    this.csv(zip, "calendar_dates.txt", (record) => {
      if (keys.includes(record.date)) {
        if (!activeDatesByService.has(record.service_id)) activeDatesByService.set(record.service_id, new Set());
        if (record.exception_type === "1") activeDatesByService.get(record.service_id).add(record.date);
        if (record.exception_type === "2") activeDatesByService.get(record.service_id).delete(record.date);
      }
      return null;
    });

    const stationRows = this.csv(zip, "stop_times.txt", (record) => (
      record.stop_id.endsWith(`-${stationCode}`) ? record : null
    ));
    const stationTripIds = new Set(stationRows.map((row) => row.trip_id));
    const trips = new Map();

    this.csv(zip, "trips.txt", (record) => {
      const activeDates = activeDatesByService.get(record.service_id);
      if (activeDates?.size && stationTripIds.has(record.trip_id)) {
        trips.set(record.trip_id, { ...record, activeDates });
      }
      return null;
    });

    const stopTimesByTrip = new Map();
    this.csv(zip, "stop_times.txt", (record) => {
      if (!trips.has(record.trip_id)) return null;
      if (!stopTimesByTrip.has(record.trip_id)) stopTimesByTrip.set(record.trip_id, []);
      stopTimesByTrip.get(record.trip_id).push(record);
      return null;
    });

    const endpointIds = new Set();
    for (const rows of stopTimesByTrip.values()) {
      rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
      endpointIds.add(rows[0].stop_id);
      endpointIds.add(rows[rows.length - 1].stop_id);
    }
    const stopNames = new Map();
    this.csv(zip, "stops.txt", (record) => {
      if (endpointIds.has(record.stop_id)) stopNames.set(record.stop_id, record.stop_name);
      return null;
    });

    const trains = [];
    for (const stationRow of stationRows) {
      const trip = trips.get(stationRow.trip_id);
      if (!trip) continue;
      const rows = stopTimesByTrip.get(stationRow.trip_id);
      const departure = this.gtfsTime(stationRow.departure_time || stationRow.arrival_time);
      for (const date of trip.activeDates) {
        trains.push({
          date,
          seconds: departure.seconds,
          time: departure.display,
          from: stopNames.get(rows[0].stop_id) || null,
          to: stopNames.get(rows[rows.length - 1].stop_id) || trip.trip_headsign || "?",
          train: trip.trip_headsign || "",
          status: null,
          alert: null,
        });
      }
    }

    trains.sort((a, b) => a.date.localeCompare(b.date) || a.seconds - b.seconds);
    this.gtfsCache = { key: cacheKey, expiresAt: Date.now() + 6 * 3600000, trains };
    return trains;
  },

  async fetchGtfsBoard(stationCode, count) {
    const { keys, nowSeconds } = this.gtfsDates();
    const trains = await this.loadGtfsSchedule(stationCode);
    return trains
      .filter((train) => train.date !== keys[0] || train.seconds >= nowSeconds - 60)
      .slice(0, count)
      .map(({ date, seconds, ...train }) => train);
  },

  async fetchBoard(cfg) {
    const slug = cfg.stationSlug || "artenay-87543058";
    const stationCode = slug.match(/(\d{8})$/)?.[1];
    const base = `https://www.ter.sncf.com/centre-val-de-loire/se-deplacer`;
    const count = cfg.maxItems || 6;
    const timeoutMs = Math.max(5000, Number(cfg.flareSolverrTimeout) || 30000);

    try {
      const [deps, arrs] = await Promise.all([
        this.fetchPage(`${base}/prochains-departs/${slug}`, timeoutMs),
        this.fetchPage(`${base}/prochaines-arrivees/${slug}`, timeoutMs)
      ]);

      const arrByTrain = {};
      for (const a of arrs) {
        if (a.line?.number) arrByTrain[a.line.number] = a;
      }

      const slice = deps.slice(0, count);

      // Compter combien de trains partagent chaque alerte
      const alertCount = {};
      for (const dep of slice) {
        for (const m of dep.situationalMessages || []) {
          if (m.categoryId !== "4" && m.body) {
            alertCount[m.body] = (alertCount[m.body] || 0) + 1;
          }
        }
      }
      // Alertes présentes sur >1 train = alerte globale, pas spécifique
      const globalBodies = new Set(
        Object.entries(alertCount).filter(([, n]) => n > 1).map(([b]) => b)
      );
      const globalAlert = [...globalBodies][0] || null;

      const trains = slice.map((dep) => {
        const num = dep.line?.number;
        const arr = arrByTrain[num];
        const messages = dep.situationalMessages || [];
        const status = this.detectStatus(messages);
        const trainAlert = status ? null : (
          messages.find(m => m.categoryId !== "4" && m.body && !globalBodies.has(m.body))?.body || null
        );
        return {
          time: this.hhmm(dep.departureDate),
          from: arr?.line?.origine?.name || null,
          to: dep.line?.destination?.name || "?",
          train: num || "",
          status,
          alert: trainAlert,
        };
      });

      this.sendSocketNotification("BOARD_DATA", { trains, globalAlert, source: "ter-sncf" });
    } catch (err) {
      console.warn(`MMM-SNCF-Station-Board: ${err.message}; bascule sur le GTFS officiel.`);
      try {
        if (!stationCode) throw new Error(`Code UIC introuvable dans le slug ${slug}`);
        const trains = await this.fetchGtfsBoard(stationCode, count);
        this.sendSocketNotification("BOARD_DATA", { trains, globalAlert: null, source: "gtfs-sncf" });
      } catch (fallbackError) {
        console.error("MMM-SNCF-Station-Board:", fallbackError.message);
        this.sendSocketNotification("BOARD_ERROR", { error: fallbackError.message });
      }
    }
  },
});
