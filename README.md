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

**Locked out?** If no admin can log in, run `server reset-password --user <name>` with the server's configuration (in development: `cd source/backend && go run ./cmd/server reset-password --user admin`; #26 adds the production command). It prints a temporary password, makes the user an active admin and ends their sessions. They must change the password when they log in.

## Layout

```
source/backend/    Go module (cmd/server, internal/…)
source/frontend/   Vite + React + TypeScript
api/openapi.yaml   REST API contract (OpenAPI)
compose.yaml       dev services (PostgreSQL)
docs/              spec and developer docs
scripts/           machine setup
```
