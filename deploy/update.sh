#!/usr/bin/env bash
# Updates the app to the newest commit on the current branch
# (docs/DEPLOYMENT.md): backs up, pulls, rebuilds and restarts. Migrations
# run when the app starts.
set -euo pipefail
cd "$(dirname "$0")"

echo "Backing up before the update…"
docker compose exec -T backup sh /usr/local/bin/backup.sh now pre-update

before=$(git rev-parse --short HEAD)
git pull --ff-only
BUCKY_VERSION=$(git describe --tags --always)
export BUCKY_VERSION

docker compose build app
docker compose up -d --wait
echo "Updated from $before to $BUCKY_VERSION."
echo "To roll back, see \"Rolling back\" in docs/DEPLOYMENT.md (the pre-update dump is in manual/)."
