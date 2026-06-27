# Deploying YoinkLand (small private server)

This brings up YoinkLand on a single VPS with automatic HTTPS, suitable for a
handful of private players. It runs two containers: the game (`app`) and
[Caddy](https://caddyserver.com) as a reverse proxy that gets/renews a free
Let's Encrypt certificate and forwards WebSocket game traffic.

## You need

- A **domain** (you have one) and access to its DNS.
- A small **VPS**. A 2 vCPU / 4 GB box (e.g. Hetzner CX22 ≈ €4.5/mo, or any
  DigitalOcean/Vultr/Linode equivalent) builds and runs this comfortably.
  (2 GB works to *run*, but the Docker build is happier with 4 GB — or add swap.)

## Steps

1. **Point DNS at the server.** Create an `A` record for your chosen hostname
   (e.g. `play.yourdomain.com`) → your VPS's public IP. Wait for it to resolve
   (`ping play.yourdomain.com`). Caddy can't get a cert until this works.

2. **Open the firewall** for ports **80** and **443** (Caddy needs 80 for the
   certificate challenge, 443 for HTTPS). On most VPSes this is a control-panel
   setting; with `ufw`:
   ```bash
   sudo ufw allow 80 && sudo ufw allow 443
   ```

3. **Install Docker** on the VPS:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

4. **Get the code** on the server (your YoinkLand fork):
   ```bash
   git clone <your-repo-url> yoinkland && cd yoinkland/deploy
   ```

5. **Configure**:
   ```bash
   cp .env.example .env
   # edit .env: set DOMAIN to your hostname, and set API_KEY to a random string
   # (e.g. `openssl rand -hex 32`)
   ```

6. **Launch**:
   ```bash
   docker compose up -d --build
   ```
   The first build takes a few minutes. Then open **https://your-domain** —
   you should see YoinkLand, and you + friends can start a private lobby.

## Updating

After pulling new changes (or editing code):

```bash
git pull
docker compose up -d --build
```

## Handy commands

```bash
docker compose logs -f app     # game server logs
docker compose logs -f caddy   # TLS / proxy logs (cert issues show here)
docker compose ps              # status
docker compose down            # stop everything
```

## Notes & limits

- **Turnstile bot-check is disabled** (`DISABLE_TURNSTILE=true`) so you don't
  need Cloudflare's external api-worker. Fine for a private server. If you ever
  go public, get a real Turnstile key and flip that off.
- **No accounts / store / cosmetics / global leaderboard** — those rely on
  OpenFront's hosted services you aren't running. Core play, bots, private
  lobbies, and the news ticker (bundled fallback) all work.
- **Scaling:** one VPS handles several concurrent games. To grow, raise
  `NUM_WORKERS` toward your vCPU count, then add more servers.
- **Before any *public* launch** (not needed for private friends): satisfy the
  AGPL by linking your source from the site, and replace the remaining
  OpenFront `/proprietary` assets (favicon, home-screen logos, gameplay
  screenshot). The wordmark and background are already yours.
