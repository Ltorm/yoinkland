<p align="center">
  <img src="resources/images/YoinkLandLogo.svg" alt="YoinkLand Logo" width="320">
</p>

# YoinkLand

**YoinkLand** is a 2D browser-based real-time territory game — a spiritual successor to
[OpenFront.io](https://openfront.io) and [territorial.io](https://territorial.io). Expand your
territory, fight bots and rival players, and dominate the map.

The headline feature is **group-vs-group matchmaking**: queue up with a party of friends (up to 3)
and get matched against other squads (up to 10 teams of 3 on one map). Nukes blow land into the sea,
and you can build **land bridges** across water — which the next nuke can blow right back up.

> **Status:** early development (ALPHA). Built as a fork of OpenFront.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)

---

## Attribution & License

YoinkLand is a fork of **[OpenFront](https://github.com/openfrontio/OpenFrontIO)**, itself a
fork/rewrite of WarFront.io (credit: https://github.com/WarFrontIO).

- **Source code** is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** — see
  [`LICENSE`](LICENSE) and [`LICENSING.md`](LICENSING.md). Because the AGPL's network clause covers
  *hosted* services, anyone running a modified YoinkLand server must offer its full corresponding
  source to users.
- The **"© OpenFront and Contributors"** notices (footer + loading screen) are preserved, as
  required by the license.
- **Assets** in [`/resources`](resources) are CC BY-SA 4.0 (attribution: "OpenFront" /
  "OpenFront Inc."). Assets in [`/proprietary`](proprietary) are **All Rights Reserved by
  OpenFront Inc.** and are *not* licensed for redistribution outside OpenFront — YoinkLand replaces
  these with its own assets over time (see [`LICENSE-ASSETS`](LICENSE-ASSETS)).

See [`CREDITS.md`](CREDITS.md) for contributors.

---

## Prerequisites

- [npm](https://www.npmjs.com/) (v10.9.2 or higher) — repo currently developed on Node 24 / npm 11
- A modern Chromium-based browser is recommended for best performance

## Quick start

> **Do NOT run `npm install` / `npm i`.** Use the pinned-install script, which runs the safer
> `npm ci --ignore-scripts` (exact `package-lock.json` versions, no install scripts) to reduce
> supply-chain risk.

```bash
npm run inst    # = npm ci --ignore-scripts
npm run dev     # client + server with live reload
```

- **Client (Vite):** http://localhost:9000
- **Server:** master on `:3000`, workers on `:3001` / `:3002`

In dev you'll see harmless warnings about failed fetches to `localhost:8787` (the cosmetics /
profanity / clan-tag service, which isn't run locally) — these can be ignored. Set
`SKIP_BROWSER_OPEN=true` to stop the browser auto-opening.

### Client / server only

```bash
npm run start:client      # client only (Vite)
npm run start:server-dev  # server only
```

## Project structure

```
/src/client   → Front-end game client (Canvas/WebGL via Pixi, Lit UI components)
/src/core     → Deterministic game simulation (terrain, territory, nukes, units)
/src/server   → Node game server (lobbies, matchmaking, WebSocket protocol)
/resources    → Open assets (CC BY-SA 4.0) and i18n language files
/proprietary  → OpenFront's restricted assets (being replaced by YoinkLand assets)
```

## Development tools

| Command | Purpose |
|---|---|
| `npm run dev` | Client + server, live reload |
| `npm test` | Run tests |
| `npm run lint` / `npm run lint:fix` | Lint (and auto-fix) |
| `npm run format` | Format code |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow and governance (inherited from OpenFront).
