/* MagicMirror – MMM-SNCF-Station-Board
 * Backend : scrape www.ter.sncf.com via FlareSolverr (contourne Cloudflare)
 * Combine départs + arrivées pour afficher : Origine => Heure => Destination
 */
const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");

const FLARESOLVERR = process.env.FLARESOLVERR_URL || "http://localhost:8191";

module.exports = NodeHelper.create({
  start() {
    console.log("MMM-SNCF-Station-Board: démarrage (FlareSolverr @ " + FLARESOLVERR + ")");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "FETCH_BOARD") {
      this.fetchBoard(payload);
    }
  },

  fetchPage(url) {
    const body = JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 });
    const parsed = new URL(FLARESOLVERR + "/v1");
    const lib = parsed.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: "/v1",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 65000,
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
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },

  async fetchBoard(cfg) {
    const slug = cfg.stationSlug || "artenay-87543058";
    const base = `https://www.ter.sncf.com/centre-val-de-loire/se-deplacer`;
    const count = cfg.maxItems || 6;

    try {
      const [deps, arrs] = await Promise.all([
        this.fetchPage(`${base}/prochains-departs/${slug}`),
        this.fetchPage(`${base}/prochaines-arrivees/${slug}`)
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

      this.sendSocketNotification("BOARD_DATA", { trains, globalAlert });
    } catch (err) {
      console.error("MMM-SNCF-Station-Board:", err.message);
      this.sendSocketNotification("BOARD_ERROR", { error: err.message });
    }
  },
});
