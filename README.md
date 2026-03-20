# MMM-SNCF-Station-Board

MagicMirror² module that displays upcoming **TER SNCF train departures and arrivals** for a given station — **no API token required**.

Data is scraped from [ter.sncf.com](https://www.ter.sncf.com) via [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr), which handles the Cloudflare protection.

```
        Orléans   12:11   Paris
          Paris   12:39   Orléans
          Paris   16:45   Orléans
        Orléans   16:49   Paris
```

## Prerequisites

This module requires a running **FlareSolverr** instance reachable from your MagicMirror server.

The simplest setup is Docker Compose:

```yaml
services:
  magic_mirror:
    image: kamasoutra/docker-magicmirror:latest
    ports: ["8080:8080"]
    volumes: ["./config:/opt/magic_mirror/config"]
    environment:
      - FLARESOLVERR_URL=http://flaresolverr:8191
    depends_on: [flaresolverr]

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    environment:
      - LOG_LEVEL=warning
    restart: unless-stopped
```

Or run FlareSolverr separately and set `FLARESOLVERR_URL` accordingly.

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Kamasoutra/MMM-SNCF-Station-Board.git
```

## Configuration

Add to your `config/config.js`:

```js
{
  module: "MMM-SNCF-Station-Board",
  position: "bottom_left",
  config: {
    stationSlug: "artenay-87543058",  // see below
    maxItems: 6,
    updateInterval: 300000,           // ms — default 5 min
    title: "Gare d'Artenay",
    stationNames: {
      "Paris Austerlitz": "Paris",    // optional display name overrides
      "Orléans": "Orléans"
    }
  }
}
```

### Finding your station slug

The slug is `<station-name>-<UIC-code>`. Look at the URL on [ter.sncf.com](https://www.ter.sncf.com) when browsing your station's departures page:

```
https://www.ter.sncf.com/centre-val-de-loire/se-deplacer/prochains-departs/artenay-87543058
                                                                             ^^^^^^^^^^^^^^^^
                                                                             this is the slug
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `stationSlug` | `"artenay-87543058"` | Station identifier from ter.sncf.com URL |
| `maxItems` | `6` | Number of trains to display |
| `updateInterval` | `300000` | Refresh interval in ms |
| `title` | `"Gare d'Artenay"` | Module header |
| `stationNames` | `{}` | Map of full names → short display names |

## Display

- **Normal**: time in white
- **Delayed**: time in orange
- **Cancelled**: time in red with strikethrough

Delay/cancellation is detected from the disruption messages embedded in the page (`situationalMessages`).

> **Note**: The first data load may take 30–60 seconds as FlareSolverr launches a headless Chrome instance to solve the Cloudflare challenge. Subsequent requests are faster.

## License

MIT
