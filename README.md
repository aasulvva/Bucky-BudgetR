# Bucky BudgetR

Self-hosted, envelope-style ("bucket") budgeting app for desktop and mobile browsers. It runs on a LAN and is reached over Tailscale.

Built with a Go REST API, a React + TypeScript frontend and PostgreSQL, deployed with Docker Compose. The full spec is in [docs/BuckyBudgetR.md](docs/BuckyBudgetR.md).

## Development

First set up your machine with [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Go, Node.js, Docker). Then:

```bash
make db-up     # start PostgreSQL (creates .env from .env.example on first run)
make migrate   # apply database migrations
make dev       # run the backend and frontend with live reload
```

Run `make` to list all targets (`db-reset`, `psql`, `generate`, `lint`, `test`, …).

## Deployment

The production stack is in `deploy/`: the app (one container, with the frontend embedded), PostgreSQL, Caddy for HTTPS on the LAN and, optionally, the tailnet, and daily backups. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers installing, updating, rolling back, backups and restoring. The `compose.yaml` at the root is for development only.

**Locked out?** If no admin can log in, run `docker compose exec app bucky-server reset-password --user admin` in `deploy/` (in development: `cd source/backend && go run ./cmd/server reset-password --user admin`). It prints a temporary password, makes the user an active admin and ends their sessions. They must change the password when they log in.

## Layout

```
source/backend/    Go module (cmd/server, internal/…)
source/frontend/   Vite + React + TypeScript
api/openapi.yaml   REST API contract (OpenAPI)
compose.yaml       dev services (PostgreSQL)
Dockerfile         production image (frontend embedded in the Go binary)
deploy/            production stack: Compose, Caddy, backup/restore/update scripts
docs/              spec, developer and deployment docs
scripts/           machine setup
```
