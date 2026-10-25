# Bucky BudgetR

Self-hosted, envelope-style ("bucket") budgeting app for desktop and mobile browsers. It runs on a LAN and is reached over Tailscale.

Built with a Go REST API, a React + TypeScript frontend and PostgreSQL, deployed with Docker Compose. The full spec is in [docs/BuckyBudgetR.md](docs/BuckyBudgetR.md).

## Quickstart

First set up your machine with [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (Go, Node.js, Docker). Then:

```bash
make db-up     # start PostgreSQL (creates .env from .env.example on first run)
make migrate   # apply database migrations
make dev       # run the backend and frontend with live reload
```

Run `make` to list all targets (`db-reset`, `psql`, `generate`, `lint`, `test`, …).

## Layout

```
source/backend/    Go module (cmd/server, internal/…)
source/frontend/   Vite + React + TypeScript
api/openapi.yaml   REST API contract (OpenAPI)
compose.yaml       dev services (PostgreSQL)
docs/              spec and developer docs
scripts/           machine setup
```
