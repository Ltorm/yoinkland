#!/usr/bin/env bash
# One-command updater for a YoinkLand self-host.
# Pulls the latest code and rebuilds/restarts the containers.
#
#   bash ~/yoinkland/deploy/update.sh
#
set -euo pipefail

# Repo root = the parent of this script's directory.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "▶ Pulling latest code…"
git pull --ff-only

echo "▶ Rebuilding & restarting containers…"
cd deploy
docker compose up -d --build

echo "✅ YoinkLand updated. Live at https://${DOMAIN:-your-domain}"
