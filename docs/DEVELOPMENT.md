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
| `SESSION_IDLE_TIMEOUT` | `168h` | A session ends after this long without use. |
| `SESSION_MAX_AGE` | `720h` | A session ends this long after login, however much it's used. At least `SESSION_IDLE_TIMEOUT`. |
| `BUCKY_INITIAL_ADMIN_PASSWORD` | `BuckyBudgetR_ADMIN_Pa$$w0rd` | Password of the `admin` account created on first start. Must meet the password policy. |

`GET /healthz` reports that the process is up. `GET /readyz` also checks the database. Every error response is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem (`application/problem+json`) with extra `code` and `request_id` fields.

Migrations are goose SQL files in `internal/db/migrations`, embedded in the binary. Create one with `go tool goose -dir internal/db/migrations create <name> sql`. Never edit a migration once it has been merged.

### IDs

Entities use the spec's random numeric IDs, made by `internal/ids`. The generators are `ids.NewUser()`, `ids.NewCycle(userID)`, `ids.NewBucketLine(bucketID)` and so on, and they draw from `crypto/rand`. IDs are digit strings of a fixed length, and composite IDs start with their owner's ID.

- **Storage:** a `text` column with `CHECK (id ~ '<ids.Kind.Pattern>')`. For a composite ID, also check its prefix, e.g. `CHECK (left(id, 6) = user_id)`. JSON carries IDs as strings, because some don't fit in a JavaScript number.
- **Inserting:** write the query as `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id` and run it through `ids.Insert`, passing its error through `ids.Inserted`. If the ID is taken, `ids.Insert` draws a new one, up to `ids.MaxAttempts` times. It then gives up with `ids.ErrIDSpaceExhausted`, which can happen with the 9,000 account IDs. A skipped conflict doesn't abort the surrounding transaction.

```go
id, err := ids.Insert(ctx, ids.User, ids.NewUser, func(ctx context.Context, id string) (bool, error) {
	_, err := q.CreateUser(ctx, sqlc.CreateUserParams{ID: id /* … */})
	return ids.Inserted(err)
})
```

### Money and the ledger

- **Amounts** are `decimal.Decimal` ([shopspring/decimal](https://github.com/shopspring/decimal)) in Go and `NUMERIC(14,2)` in PostgreSQL. Exchange rates are `NUMERIC(18,8)`. Never use `float64` for money. pgx and sqlc map `numeric` to `decimal.Decimal` (`db.Configure`), and JSON carries amounts as strings.
- **Currencies:** `money.ValidCurrency` accepts ISO 4217 codes (from `golang.org/x/text/currency`) for real currencies with at most 2 decimals. Use it wherever a currency comes in.
- **Rounding:** calculate at full precision, then round the result with `money.Round`, which rounds half away from zero, the same as PostgreSQL's numeric cast. The ledger rejects an amount with more than 2 decimals instead of rounding it, so round where you calculate.
- **Recording:** `internal/ledger` writes a header and its lines in one go:
  - `ledger.Create(ctx, pool, entry)` runs in its own DB transaction;
  - `Record(ctx, tx, entry)` runs inside yours, for example to create an account together with its OPB.
  - It checks the line counts per type (spec §5.4), that every account and bucket is the user's and not deleted, and that bucket lines fall within the user's active cycle (they get that cycle's ID).
  - Sign rules and other per-type rules belong to the caller.
  - Errors wrap `ledger.ErrInvalid`, `ErrNotFound`, `ErrNoActiveCycle`, `ErrOutsideCycle` or `ErrUnsupported`.
- **Immutable:** a trigger rejects UPDATE, DELETE and TRUNCATE on `transaction_headers`, `bank_transactions`, `bucket_transactions` and `transaction_tags`. Change a transaction by recording a correction (`Correction` and `ParentID`).
- **Times:** a transaction's time (`transaction_at`) and a cycle's bounds (`start_at`, `end_at`) are UTC `timestamptz`. A cycle runs from `start_at` up to, but not including, `end_at`. The frontend turns the cycle dates the user picks into the UTC moments of local midnight: a cycle from 01.11 to 30.11 in Oslo is stored as 31.10 23:00 up to 30.11 23:00 UTC. Use the time zone (`Europe/Oslo`), not a fixed offset, because the offset changes with summer time.
- **IDs:** a transaction ID starts with the UTC date of its time (`YYYYMMDD`), and a CHECK constraint enforces this. A purchase at 00:30 in Oslo gets the previous day's date.
- **Services:** feature packages such as `internal/accounts` do their checks and writes in one DB transaction and record money movements with `ledger.Record` inside it, so an account never exists without its opening balance and is never deleted half-settled. They lock the rows they change (`FOR UPDATE`); the ledger locks the accounts and buckets it records on `FOR SHARE`, so it waits for them.
- **Cycles:** `internal/cycles` plans, starts, extends and ends cycles. `cycles.Options.OnEnd` and `OnStart` run inside the transaction that ends or starts a cycle; the cycle routines (OVF and REF, #19) plug in there. A `cycles_no_overlap` exclusion constraint (btree_gist) keeps a user's cycles apart.
- **Buckets:** `internal/buckets` creates, changes and deletes buckets. The currency is the source account's (read through a join, not stored). BC is calculated (`buckets.Capacity`) from the stored cap mode and its value. CAF is stored for the Money Allocation Routine (#17); the service only resets it, when the source account changes or the bucket is deleted. Opening funds (OPF) and the release of TF on delete (BUA) are bucket lines, so they need an active cycle.
- **Transactions:** `internal/transactions` creates INC, EXP and TRF (signs, bucket sources, the bucket-line sum, no future dates, same-currency transfers) and reads them merged with their corrections. `Correct` turns desired values into an adjustment holding the difference (or reverses and re-creates when the account changes, linked by `replaces_id`), and `Reverse` negates the effective lines; both lock the original's header `FOR UPDATE` and date their lines at the original time. The list pages with a keyset cursor on (`transaction_at`, `id`), newest first.
- **Allocation:** `internal/allocation` is the Money Allocation Routine. `Allocate` is the pure split (property-tested); `Run` clamps and, on the §7 triggers (or when forced), recalculates the stored `buckets.caf` for some accounts. The ledger runs it through `AfterRecord` (wired in `cmd/server`); the buckets and accounts services force it when bucket settings change.
- **Refills:** `internal/refill` holds the cycle routines (spec §6). `OnEnd`/`OnStart` are the cycles hooks (wired in `cmd/server`); `Manual` serves the refill endpoint; the transactions service calls `OnIncome` when an income triggers a refill and `UndoIncome` when it is reversed or moved. The `refills` table (PK bucket + cycle) makes "once per cycle" a database guarantee and links each REF/OVF to the income that triggered it.
- **User lock:** every service write takes `ledger.LockUser` first, a transaction-scoped advisory lock per user. A user's money writes then run one at a time; without it, the ledger's `FOR SHARE` row locks and the allocation's CAF updates deadlock under concurrent transactions (see `allocation.TestConcurrent`). Take it before any row lock in new write paths.
- **Balances:** `internal/balance` calculates account balances (now, or before a moment), bucket TF and a bucket's figures for a cycle (start, budget, used, overflow, left; spec §4) from the ledger lines. Nothing is stored. Covering indexes on the line tables keep the sums cheap.
- **Hook:** `ledger.Options.AfterRecord` runs after each recorded transaction, inside the same DB transaction. The Money Allocation Routine plugs in there.
- **Tests:** `internal/ledgertest` creates bare accounts, cycles and buckets for tests.

### API contract

`api/openapi.yaml` (OpenAPI 3.0.3, the version oapi-codegen supports) is the source of truth for the REST API. To add or change an endpoint:

1. Edit the spec. Resources go under `/api/v1`. IDs and amounts are strings, as described in the spec's conventions.
2. Run `make generate`. oapi-codegen regenerates `internal/api/api.gen.go` (the models, the routes and a `StrictServerInterface`), and openapi-typescript regenerates the frontend's `src/api/schema.d.ts`.
3. Implement the new method on `server` in `internal/httpapi/handlers.go`. The build fails until you do. To answer with an error, return an `*httpapi.Error`. It becomes a problem response with its status and code. Any other error is logged and becomes a 500.
4. Run `make lint`. It lints the spec with Redocly CLI (via `npx`, so it needs Node.js) as well as the Go code.

Commit the generated code. `make generate-check` fails if it is out of date, and CI runs it.

With `APP_ENV=development`, the interactive docs (Scalar) are at <http://localhost:8080/api/docs> and the spec as JSON at `/api/openapi.json`. Neither is served in production.

### Auth

`internal/auth` handles passwords, sessions and rate limiting. `internal/httpapi` applies them to requests.

- **First start:** when there are no users, the server creates `admin` with `BUCKY_INITIAL_ADMIN_PASSWORD`, or the default above, and logs a warning if the default is used. The account must change its password before it can do anything except `GET /api/v1/me`, `POST /api/v1/me/password` and logout (403 `password_change_required`). Because `.env` values can't contain `$`, the default password can't be set there; use it as-is or pick another.
- **Passwords:** bcrypt at cost 12, 12–72 bytes long. A new password must differ from the current one.
- **Sessions:** login sets the `__Host-bucky_session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`). The token is 32 random bytes; the database stores only its SHA-256. A session ends after `SESSION_IDLE_TIMEOUT` without use or `SESSION_MAX_AGE` after login. Changing the password ends the user's other sessions. Browsers accept `Secure` cookies on `http://localhost`, so dev works through the Vite proxy without TLS.
- **Access rules come from the spec:** an operation is public only if it has `security: []`, and `x-allowed-before-password-change: true` lets a user who must change their password call it. Requests are also validated against the spec (parameters, body schema, no unknown fields) before the handler runs: 400 `invalid_request`, or 413 above 1 MB.
- **CSRF:** every POST, PUT, PATCH and DELETE under `/api/` must send `X-Bucky-CSRF: 1`, and its `Origin`, if present, must match the host (403 `csrf` otherwise). The frontend's `api` client adds the header. Other clients, such as curl or scripts, must add it themselves.
- **Rate limiting:** after 5 failed logins within 15 minutes for a username or a client IP, logins are refused with 429 `too_many_attempts` and `Retry-After`. The lockout starts at 1 minute and doubles up to 15. The counters are in memory and reset on restart. The client IP is the connection's address; `X-Forwarded-For` is ignored until a trusted proxy is configured (#26).
- **Tests:** `internal/authtest` creates users (`authtest.NewUser`) and logs them in (`authtest.Login`) against a real handler. Every feature that stores user data should have a test that one user can't see or change another's.

Trying it with curl:

```bash
curl -c jar -H 'X-Bucky-CSRF: 1' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"BuckyBudgetR_ADMIN_Pa$$w0rd"}' localhost:8080/api/v1/auth/login
curl -b jar localhost:8080/api/v1/me
```

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

- `app/nav.ts` is the navigation in one place (spec §9): the groups, the screens in each, the profile menu's screens, and the issue that builds each screen. The side menu (desktop), the bottom tabs and their sheets (mobile), the profile menu and the routes are all built from it. A screen without a page component gets a placeholder. To build a screen, add its page to `pages` in `app/routes.tsx`.
- `app/session.ts` is the session: `useSession()` gives the logged-in user (the `["me"]` query, null without a session), and `useSignOut()` logs out.
  - `app/RequireSession.tsx` guards every screen in the shell. Without a session it sends the user to `/login?next=<path>`, and to `/change-password` when the password must change first. `/login` and `/change-password` live outside the shell.
  - When any query or mutation gets 401 `unauthenticated`, the session is reset and the guard takes over. The login page then says the session has ended. A 403 `password_change_required` refetches the session instead. Neither shows an error notification.
- `api/` holds the API client.
  - `client.ts` is the typed client. Always call it through `unwrap()`, which returns the data or throws an `ApiError` carrying the server's problem details.
  - `accounts.ts` and the like hold the queries the screens share (`useAccounts()`, `useBuckets()`), with their query keys. `useRefreshMoney()` refetches everything a transaction or account change can move: balances, unallocated, the buckets' TF and CAF, and transaction lists.
  - `queryClient.ts` sets the query defaults. Queries retry twice, but never on 4xx. A failed mutation shows an error notification unless it sets `meta: { silentError: true }`.
- `components/QueryState.tsx` is the standard way to render a query: a spinner while loading, an error with its request ID and a Retry button, otherwise the data.
- `components/DateTimeInput.tsx` picks when something happened, in local time. Its value is the UTC timestamp the API takes, or null for now. It can't pick the future.
- `lib/` holds the formatting helpers. Their locale and currency settings are in `lib/locale.ts`: the user's locale preference (or the browser's), and NOK. The guard calls `setLocale()` from the session. When the locale changes, the guard remounts the screens so that they format again.

Money is never a JS `number`. The API sends and receives amounts as decimal strings (`"1234.50"`):
- `formatMoney()` formats one exactly, in NOK or the currency given (an account's or bucket's).
- `addAmounts()`, `subtractAmounts()` and `compareAmounts()` calculate with them exactly, in BigInt cents.
- `<AmountInput>` takes what the user types (`1 234,5`) and emits the canonical string, or `null` if the input is invalid.
- API dates (`YYYY-MM-DD`) go through `lib/dates.ts`, so they don't shift a day in other time zones.

Cycles are picked as local dates, but the API takes timestamps (spec §3). `lib/cycles.ts` does the conversion:
- `startAtFor(date)` is the UTC moment of that date's local midnight.
- `endAtFor(lastDay)` is the next local midnight, since `end_at` is exclusive.
- `firstDay()` and `lastDay()` convert back.

The End cycle confirmation previews the OVF and REF with `lib/cycleEnd.ts`. It mirrors the routines in `internal/refill/refill.go`, so a change to one needs the same change in the other.

Tests run in jsdom. `src/test/render.tsx` has helpers that render a component with the app's providers (the real query client, minus retries), or the whole app at a given path. `viewport.width` from `src/test/setup.ts` switches between the desktop and mobile layouts.

Tests never reach a server. `src/test/fixtures.ts` builds sample accounts and buckets. `src/test/api.ts` is a fake backend that `setup.ts` installs as `fetch`. By default it answers as a logged-in normal user, `testUser`. A test changes an answer with `apiMock.on("PATCH /api/v1/me/preferences", { body: … })`, or with a function of the request; `problem(status, code, detail)` builds an error. The test then checks what was sent with `apiMock.calls(route)`. The answers reset after each test.

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
