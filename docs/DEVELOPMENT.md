# Development setup

How to set up a dev machine for Bucky BudgetR. Written for **Fedora 44**. Other distros need the equivalent packages.

## How it works

The setup is **hybrid**:

- Go (backend) and Vite (frontend) run **natively**, for fast reloads and full IDE support.
- PostgreSQL runs in **Docker Compose**. In production the whole stack runs in Compose.

| Tool | Version | Source |
| ---- | ------- | ------ |
| VS Code | latest | Microsoft RPM repo. Use this rather than the Flatpak, whose sandbox gets in the way of Docker and the toolchains. |
| Go | Fedora's `golang` (1.26) | Fedora repo |
| Node.js | 24 LTS (pinned in `.nvmrc`) | Fedora repo (`nodejs24`) |
| Docker | Docker Engine + Compose plugin (native, no Docker Desktop) | Docker's repo |

Go dev tools (sqlc, goose, oapi-codegen, air, golangci-lint) are **not** installed globally. They are pinned in the backend's `go.mod` with `go get -tool` and run with `go tool <name>`.

## Quick setup

```bash
./scripts/setup-fedora.sh
```

The script asks for your sudo password. It is safe to re-run. It:

1. adds the VS Code repo (and Docker's repo, if it is missing);
2. removes Docker Desktop if it is installed;
3. installs VS Code, Go, Node.js 24 and Docker Engine;
4. starts the Docker daemon and adds you to the `docker` group;
5. adds `$(go env GOPATH)/bin` to your `PATH` (`~/.bashrc.d/go.sh`);
6. installs the VS Code extensions listed in `.vscode/extensions.json`;
7. prints the versions and runs `hello-world` to test Docker.

**Afterwards, log out and back in** so the new `docker` group membership and `PATH` take effect.

## Verify

```bash
code --version && go version && node -v && npm -v && docker compose version
docker run --rm hello-world   # must work without sudo
```

## VS Code

- Open the repo folder. VS Code suggests the recommended extensions from `.vscode/extensions.json`.
- `.vscode/settings.json` turns on format-on-save: gopls for Go (with import organising), Prettier for TS/JSON/CSS, and ESLint fixes on save. Markdown is not auto-formatted.

## Backend

The Go service lives in `source/backend`. `make dev-backend` runs it with live reload (air). The server applies pending migrations on startup.

```bash
go run ./cmd/server           # start the server
go run ./cmd/server migrate   # apply migrations and exit
```

It is configured with environment variables. The Makefile exports everything in `.env`, so `make` targets pick them up.

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | (required) | The Makefile builds it from the `POSTGRES_*` values. |
| `APP_ENV` | `production` | `development` or `production`. `.env.example` sets `development`. |
| `API_HOST` | all interfaces | `.env.example` sets `127.0.0.1`. |
| `API_PORT` | `8080` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `LOG_FORMAT` | `text` in development, `json` in production | |
| `MIGRATE_ON_START` | `true` | |
| `SHUTDOWN_TIMEOUT` | `10s` | How long to wait for in-flight requests on shutdown. |

`GET /healthz` reports that the process is up. `GET /readyz` also checks the database. Every error response is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem (`application/problem+json`) with extra `code` and `request_id` fields.

Migrations are goose SQL files in `internal/db/migrations`, embedded in the binary. Create one with `go tool goose -dir internal/db/migrations create <name> sql`. Never edit a migration once it has been merged.

### Tests

`make test` starts the dev database and runs the tests. A test that needs PostgreSQL calls `testdb.New(t)` and gets its own database. That database is copied from a migrated template (`bucky_test_tmpl_<hash>`) and dropped when the test ends, so tests can commit and run in parallel. The template is rebuilt whenever the migrations change. Set `TEST_DATABASE_URL` to use another server. Without a database URL these tests are skipped, except when `CI` is set, where they fail.

## Troubleshooting

- **`permission denied … /var/run/docker.sock`**: you haven't logged out and back in since being added to the `docker` group. As a temporary fix, run `newgrp docker` in the current shell.
- **`docker` talks to Podman**: don't install `podman-docker`. It provides a conflicting `docker` command. Podman itself can stay installed.
- **`docker` points at a stale Docker Desktop context**: run `docker context use default`.
