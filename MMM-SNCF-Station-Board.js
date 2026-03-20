/* MagicMirror – MMM-SNCF-Station-Board
 * Affiche le tableau de passage en gare : Origine => Heure => Destination
 *
 * Config :
 *   stationSlug    : slug TER de la gare     ex. "artenay-87543058"
 *   maxItems       : nb de trains affichés   (défaut 6)
 *   updateInterval : rafraîchissement ms      (défaut 60000)
 *   title          : titre du module          (défaut "Gare d'Artenay")
 *   stationNames   : mapping de noms courts   ex. {"Paris Austerlitz": "Paris"}
 */
Module.register("MMM-SNCF-Station-Board", {
  defaults: {
    stationSlug: "artenay-87543058",
    maxItems: 6,
    updateInterval: 60 * 1000,
    animationSpeed: 800,
    title: "Gare d'Artenay",
    stationNames: {},
  },

  getStyles() {
    return ["MMM-SNCF-Station-Board.css"];
  },

  getHeader() {
    return this.config.title;
  },

  start() {
    this.trains = [];
    this.loaded = false;
    this.error = null;
    this.fetchBoard();
    setInterval(() => this.fetchBoard(), this.config.updateInterval);
  },

  fetchBoard() {
    this.sendSocketNotification("FETCH_BOARD", this.config);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "BOARD_DATA") {
      this.trains = payload.trains;
      this.loaded = true;
      this.error = null;
      this.updateDom(this.config.animationSpeed);
    } else if (notification === "BOARD_ERROR") {
      this.loaded = true;
      this.error = payload.error;
      this.updateDom(this.config.animationSpeed);
    }
  },

  label(name) {
    return (name && this.config.stationNames[name]) || name || "–";
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-navitia-board";

    if (!this.loaded) {
      const el = document.createElement("div");
      el.className = "nb-loading dimmed";
      el.textContent = "Chargement…";
      wrapper.appendChild(el);
      return wrapper;
    }

    if (this.error) {
      const el = document.createElement("div");
      el.className = "nb-error";
      el.textContent = this.error;
      wrapper.appendChild(el);
      return wrapper;
    }

    if (!this.trains || this.trains.length === 0) {
      const el = document.createElement("div");
      el.className = "nb-empty dimmed";
      el.textContent = "Aucun train";
      wrapper.appendChild(el);
      return wrapper;
    }

    const table = document.createElement("table");
    table.className = "nb-table";

    for (const t of this.trains) {
      const row = document.createElement("tr");
      row.className = "nb-row";

      // Origine
      const tdFrom = document.createElement("td");
      tdFrom.className = "nb-from" + (t.status === "cancelled" ? " nb-cancelled" : "");
      tdFrom.textContent = this.label(t.from);
      row.appendChild(tdFrom);

      // Espace gauche
      row.appendChild(document.createElement("td")).className = "nb-gap-left";

      // Heure (centré, mis en valeur)
      const tdTime = document.createElement("td");
      const timeClass = t.status === "delayed" ? " nb-time-delayed"
                      : t.status === "cancelled" ? " nb-time-cancelled" : "";
      tdTime.className = "nb-time" + timeClass;
      tdTime.textContent = t.time || "??:??";
      row.appendChild(tdTime);

      // Espace droit
      row.appendChild(document.createElement("td")).className = "nb-gap-right";

      // Destination
      const tdTo = document.createElement("td");
      tdTo.className = "nb-to" + (t.status === "cancelled" ? " nb-cancelled" : "");
      tdTo.textContent = this.label(t.to);
      row.appendChild(tdTo);

      // Alerte perturbation (ligne supplémentaire si présente)
      if (t.alert) {
        const alertRow = document.createElement("tr");
        const alertCell = document.createElement("td");
        alertCell.colSpan = 5;
        alertCell.className = "nb-alert";
        alertCell.textContent = t.alert;
        alertRow.appendChild(alertCell);
        table.appendChild(row);
        table.appendChild(alertRow);
        continue;
      }

      table.appendChild(row);
    }

    wrapper.appendChild(table);
    return wrapper;
  },
});
