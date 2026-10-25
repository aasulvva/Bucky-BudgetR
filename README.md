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

Not available yet. Production images, a production Compose stack, HTTPS over Tailscale and backups are tracked in [#26](https://github.com/aasulvva/Bucky-BudgetR/issues/26). `compose.yaml` in this repo is for development only.

## Layout

```
source/backend/    Go module (cmd/server, internal/…)
source/frontend/   Vite + React + TypeScript
api/openapi.yaml   REST API contract (OpenAPI)
compose.yaml       dev services (PostgreSQL)
docs/              spec and developer docs
scripts/           machine setup
```
