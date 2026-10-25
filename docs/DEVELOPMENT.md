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

### API contract

`api/openapi.yaml` (OpenAPI 3.0.3, the version oapi-codegen supports) is the source of truth for the REST API. To add or change an endpoint:

1. Edit the spec. Resources go under `/api/v1`. IDs and amounts are strings, as described in the spec's conventions.
2. Run `make generate`. oapi-codegen regenerates `internal/api/api.gen.go` (the models, the routes and a `StrictServerInterface`), and openapi-typescript regenerates the frontend's `src/api/schema.d.ts`.
3. Implement the new method on `server` in `internal/httpapi/handlers.go`. The build fails until you do. To answer with an error, return an `*httpapi.Error`. It becomes a problem response with its status and code. Any other error is logged and becomes a 500.
4. Run `make lint`. It lints the spec with Redocly CLI (via `npx`, so it needs Node.js) as well as the Go code.

Commit the generated code. `make generate-check` fails if it is out of date, and CI runs it.

With `APP_ENV=development`, the interactive docs (Scalar) are at <http://localhost:8080/api/docs> and the spec as JSON at `/api/openapi.json`. Neither is served in production.

### Tests

`make test` starts the dev database and runs the tests. A test that needs PostgreSQL calls `testdb.New(t)` and gets its own database. That database is copied from a migrated template (`bucky_test_tmpl_<hash>`) and dropped when the test ends, so tests can commit and run in parallel. The template is rebuilt whenever the migrations change. Set `TEST_DATABASE_URL` to use another server. Without a database URL these tests are skipped, except when `CI` is set, where they fail.

## Frontend

The React app lives in `source/frontend`. It uses Vite, TypeScript (strict), Mantine, React Router and TanStack Query. `make dev-frontend` (or `npm run dev` there) serves it at <http://localhost:5173>. Vite forwards `/api`, `/healthz` and `/readyz` to the backend, so API calls are same-origin.

| npm script | |
| --- | --- |
| `dev` | Vite dev server |
| `build` | Type-check and build into `dist/` |
| `generate` | Regenerate the typed API client from the spec (part of `make generate`) |
| `lint` / `typecheck` | ESLint / `tsc` (part of `make lint`) |
| `test` | Vitest (part of `make test`) |
| `format` | Prettier |

Layout of `src/`:

- `app/nav.ts` is the navigation in one place: tabs, the screens in each tab, and the issue that builds each screen. The side menu (desktop), the bottom tabs and sub-menus (mobile) and the routes are all built from it. A screen without a page component gets a placeholder. To build a screen, add its page to `pages` in `app/routes.tsx`.
- `api/` holds the API client.
  - `client.ts` is the typed client. Always call it through `unwrap()`, which returns the data or throws an `ApiError` carrying the server's problem details.
  - `queryClient.ts` sets the query defaults. Queries retry twice, but never on 4xx. A failed mutation shows an error notification unless it sets `meta: { silentError: true }`.
- `components/QueryState.tsx` is the standard way to render a query: a spinner while loading, an error with its request ID and a Retry button, otherwise the data.
- `lib/` holds the formatting helpers. Their locale and currency settings are in `lib/locale.ts`: the browser's locale, and NOK.

Money is never a JS `number`. The API sends and receives amounts as decimal strings (`"1234.50"`):
- `formatMoney()` formats one exactly.
- `<AmountInput>` takes what the user types (`1 234,5`) and emits the canonical string, or `null` if the input is invalid.
- API dates (`YYYY-MM-DD`) go through `lib/dates.ts`, so they don't shift a day in other time zones.

Tests run in jsdom. `src/test/render.tsx` has helpers that render a component with the app's providers, or the whole app at a given path. `viewport.width` from `src/test/setup.ts` switches between the desktop and mobile layouts.

## Workflow and CI

- Work on a branch and merge to `main` through a pull request. The repo is private on GitHub's free plan, which doesn't enforce branch protection, so this is a convention: **merge only when CI is green**.
- `.github/workflows/ci.yml` runs on every PR and on every push to `main`. It has three jobs:
  - **Backend:** `go mod verify`, `go vet`, golangci-lint, then `go test -race` against a PostgreSQL service container, then a build.
  - **Frontend:** `npm ci`, ESLint, `tsc`, Vitest and `vite build`.
  - **API contract:** `make lint-spec` and `make generate-check`, which fails if the committed generated code is out of date.
- To reproduce CI locally, run `make lint test generate-check`.
- Dependabot (`.github/dependabot.yml`) opens weekly PRs for Go modules, npm, GitHub Actions and the Compose image. Minor and patch updates are grouped, and a release must be a week old first.
  - Actions are pinned to commit SHAs. Dependabot updates the SHA and its version comment together.
  - A few versions are outside Dependabot's reach and are bumped by hand. They're listed at the top of `dependabot.yml`.

## Troubleshooting

- **`permission denied … /var/run/docker.sock`**: you haven't logged out and back in since being added to the `docker` group. As a temporary fix, run `newgrp docker` in the current shell.
- **`docker` talks to Podman**: don't install `podman-docker`. It provides a conflicting `docker` command. Podman itself can stay installed.
- **`docker` points at a stale Docker Desktop context**: run `docker context use default`.
