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

The Go service lives in `source/backend`. `make dev-backend` runs it with live reload (air). The server applies pending migrations on startup. It first stops a dev server left over from an earlier run: air can lose track of its server, which then keeps the port, so the new one can't start and the old code keeps answering.

```bash
go run ./cmd/server               # start the server
go run ./cmd/server migrate       # apply migrations and exit
go run ./cmd/server healthcheck   # exit 0 if the running server is ready (the image's health check)
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
| `SCHEDULE_INTERVAL` | `30s` | How often the scheduler looks for scheduled transactions that are due (#31). At least `1s`. |
| `BUCKY_INITIAL_ADMIN_PASSWORD` | `BuckyBudgetR_ADMIN_Pa$$w0rd` | Password of the `admin` account created on first start. Must meet the password policy. |
| `TRUSTED_PROXIES` | (none) | Comma-separated addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For` gives the client's address. `deploy/compose.yaml` sets Caddy's. |
| `PDF_CHROME_URL` | (none) | The headless Chrome's DevTools address for report PDFs (#127), e.g. `http://chrome:9222`. Set with `PDF_APP_URL`, or neither: without them, *Export PDF* answers 503 `pdf_unavailable`. |
| `PDF_APP_URL` | (none) | The app as that Chrome reaches it, e.g. `http://app:8080`, or Vite in dev. No path. |

`GET /healthz` reports that the process is up. `GET /readyz` also checks the database. Every error response is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem (`application/problem+json`) with extra `code` and `request_id` fields. The frontend shows `request_id` as the error's *reference*, which an admin can paste into the Logs screen.

**Logging:** the server logs with `log/slog` to stderr (`LOG_LEVEL`, `LOG_FORMAT`), and `internal/logging.Store` also keeps some records in `log_entries` for the Logs screen (#93): everything at Warn or above, Info records with an `event` attribute (`logging.EventKey`, e.g. `cycle.started`) and records with an `audit` attribute (`logging.AuditKey`, e.g. `user.created`; in handlers, `server.audit`). The request ID and the user come from the request's context. To record a new event or admin action, add the attribute, and a label in `src/lib/logs.ts` (`KNOWN_EVENTS`) and `admin.logs.events` in the translations. Never log passwords, tokens, links or amounts. Entries wait in a buffer until the migrations have run, are written in batches, and are dropped (with a warning on stderr) if the buffer fills. Retention is in `log_settings`, set on the Logs screen; `logging.Service.CleanupLoop` deletes older entries hourly.

**The frontend in production:** `internal/web` embeds `internal/web/dist` and serves it for every GET outside `/api/` and the health probes. Unknown paths get `index.html`, so the app's routes load the app. It also sets caching and the Content-Security-Policy. The Dockerfile copies the frontend build there. The repo holds only a `.gitkeep`, so in development every page is a 404 from the Go server, and Vite serves the frontend instead.

**The production image:** the root `Dockerfile` builds the frontend, then the Go binary with the frontend embedded, as `bucky-server` on distroless (non-root, no shell). Build it with `docker build --build-arg VERSION=$(git describe --tags --always) .`. The version is logged at startup. Deploying it is described in [DEPLOYMENT.md](DEPLOYMENT.md).

Migrations are goose SQL files in `internal/db/migrations`, embedded in the binary. Create one with `go tool goose -dir internal/db/migrations create -s <name> sql`, then check its number follows the Go migrations' too (goose's CLI can't see those). A migration that needs code (converting JSON in `users.preferences`, for example) is a Go migration, registered in `goMigrations` in `internal/db/migrate.go` (00024, #201, converts saved graphs to saved modules with `internal/preferences`, which the export's upgrade uses too). `make migrate` runs the server's `migrate` command, which applies both kinds; tests get both through `testdb`. Never edit a migration once it has been merged.

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
- **Transactions:** `internal/transactions` creates INC, EXP and TRF (signs, bucket sources, the bucket-line sum, no future dates, same-currency transfers) and reads them merged with their corrections. `Correct` turns desired values into an adjustment holding the difference (or reverses and re-creates when the account changes, linked by `replaces_id`), and `Reverse` negates the effective lines; both lock the original's header `FOR UPDATE` and date their lines at the original time. The list pages with a keyset cursor on (`transaction_at`, `id`), newest first; `order=oldest` lists the oldest first (the cursor then continues after the last row); its account, bucket and tag filters take several values, matching any of them (#126), and the balance after each (#106) is only filled with exactly one account.
- **Allocation:** `internal/allocation` is the Money Allocation Routine. `Allocate` is the pure split (property-tested); `Run` clamps and, on the §7 triggers (or when forced), recalculates the stored `buckets.caf` for some accounts. The ledger runs it through `AfterRecord` (wired in `cmd/server`); the buckets and accounts services force it when bucket settings change.
- **Refills:** `internal/refill` holds the cycle routines (spec §6). `OnEnd`/`OnStart` are the cycles hooks (wired in `cmd/server`); `Manual` serves the refill endpoint; the transactions service calls `OnIncome` when an income triggers a refill and `UndoIncome` when it is reversed or moved. The `refills` table (PK bucket + cycle) makes "once per cycle" a database guarantee and links each REF/OVF to the income that triggered it.
- **User lock:** every service write takes `ledger.LockUser` first, a transaction-scoped advisory lock per user. A user's money writes then run one at a time; without it, the ledger's `FOR SHARE` row locks and the allocation's CAF updates deadlock under concurrent transactions (see `allocation.TestConcurrent`). Take it before any row lock in new write paths.
- **Balances:** `internal/balance` calculates account balances (now, or before a moment), bucket TF and a bucket's figures for a cycle (start, budget, used, overflow, left; spec §4) from the ledger lines. Nothing is stored. Covering indexes on the line tables keep the sums cheap.
- **Stats:** `internal/stats` serves the Stats API (#121). `stats.sql` returns each transaction family's net per account or bucket (dated by the original, filtered by the family's newest header, as the transaction list does) and the balance lines; Go cuts the period into intervals in the request's time zone (`stats.Cut`: hours by the clock, days to years by local midnight, weeks from `week_start`; cycles from the user's cycles) and adds the nets up. Amounts in different currencies never add up: `group_by: none` gives one series per currency. By bucket, *No bucket* is a family's bank net minus its bucket nets. A balance series dates lines by their own header, as `AccountBalancesBefore`. At most 1000 intervals (`too_many_intervals`). `GET /api/v1/stats/flows` (#126, `stats.Flows`) cuts the period the same way, per month, cycle or as one interval, and gives each bucket its TF at the start (`StatsBucketStarts`: its bucket lines dated before `from`), its in (refills, income, opening funds, adjustments and transfers in) and out (spent, overflow, adjustments and transfers out) from `StatsBucketNets`, and its end, carried on to the next interval; and each account its income, expenses and transfers in and out from `StatsBankNets`. Only account and bucket filters apply.
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
- **Access rules come from the spec:** an operation is public only if it has `security: []`, `x-allowed-before-password-change: true` lets a user who must change their password call it, and `x-admin-only: true` refuses non-admins (403 `admin_only`). Requests are also validated against the spec (parameters, body schema, no unknown fields) before the handler runs: 400 `invalid_request`, or 413 above 1 MB (an operation can raise that with `x-max-body-bytes`, as the data import does).
- **CSRF:** every POST, PUT, PATCH and DELETE under `/api/` must send `X-Bucky-CSRF: 1`, and its `Origin`, if present, must match the host (403 `csrf` otherwise). The frontend's `api` client adds the header. Other clients, such as curl or scripts, must add it themselves.
- **Rate limiting:** after 5 failed logins within 15 minutes for a username or a client IP, logins are refused with 429 `too_many_attempts` and `Retry-After`. The lockout starts at 1 minute and doubles up to 15. The counters are in memory and reset on restart. The client IP is the connection's address, or behind a proxy in `TRUSTED_PROXIES`, the address that proxy put in `X-Forwarded-For` (`httpapi.ClientAddr`). The access log records it as `client_ip`.
- **User management:** `auth/admin.go` creates users, activates and deactivates them, grants and revokes admin and resets passwords, for the `/api/v1/admin/users` endpoints. The user gets in with a temporary password from `auth.TemporaryPassword`, which they must change at the next login, or with a setup or reset link (`auth/links.go`, table `password_links`): a 32-byte token in the fragment of `/set-password#<token>`, stored as its SHA-256, single use and valid for `auth.LinkTTL` (24 hours). The public `POST /api/v1/auth/password-link` checks a link and `…/use` sets the password and logs in. Admin changes run under an advisory lock so the last active admin can't be removed by two requests at once. `auth.RecoverAdmin` backs `server reset-password --user <name>`, for when no admin can log in.
- **Tests:** `internal/authtest` creates users (`authtest.NewUser`) and logs them in (`authtest.Login`) against a real handler. Every feature that stores user data should have a test that one user can't see or change another's.

Trying it with curl:

```bash
curl -c jar -H 'X-Bucky-CSRF: 1' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"BuckyBudgetR_ADMIN_Pa$$w0rd"}' localhost:8080/api/v1/auth/login
curl -b jar localhost:8080/api/v1/me
```

### Cycle rule

The cycle rule (#72, spec §3) plans cycles on the server, in the user's `time_zone` preference.
- `internal/calendar` holds the dates, with no database: `Rule.Start` gives a month's date (clamped to the month, then moved off weekends and holidays), `Rule.Periods` the periods from one date to the next, and `norwegian` the Norwegian bank holidays (Easter from the Gregorian computus).
- `cycles/rule.go` plans with them. `topUp` adds cycles after the latest one, flagged `generated`, until the rule's `ahead` are planned. It runs inside `Start` and `End`, after an extension that deleted planned cycles (`pushNext`, #158), hourly (`PlanLoop`), and through `Replan` when a preferences PATCH touches `cycle_rule` or `time_zone`. `Replan` first deletes the generated cycles that haven't started. `SetCycleTimes` clears the flag, so a cycle moved by hand (or pushed along) is the user's.
- `POST /api/v1/cycle-rule/periods` previews a rule without saving it; Settings and the cycle dialogs use it, so the holidays live only in Go.
- The binary embeds `time/tzdata`, so zones work in the distroless image.

### Scheduled transactions

Schedules (#31, spec §5.6) live in `internal/schedules`.
- `recurrence.go` is the date math, with no database: `Rule.Occurrence(k)` is occurrence `k` (from 0) as a wall time in the schedule's zone, with months and years clamped from the start date so the day doesn't drift. `Rule.NextAt(t)` is the first at or after `t`. A schedule stores `next_index` and `next_at` (UTC), and `next_at` is null once it has ended.
- `scheduler.go` runs `RunDue` at start and every `SCHEDULE_INTERVAL` (`RunLoop`, on the business clock, so the debug clock moves it too). For each user with something due, one database transaction takes `ledger.LockUser`, locks the due schedules (`FOR UPDATE`) and handles their occurrences up to now in order, at most `MaxCatchUp` per schedule per run. An occurrence that already has a row in `schedule_occurrences` (unique per schedule and time) is skipped, so a repeated run records nothing twice.
- An auto occurrence is recorded with `transactions.Service.RecordIn` inside a savepoint. If it fails with a rule error (`ledger.ErrNoActiveCycle`, `ErrOutsideCycle`, `ErrInvalid` and the like), the savepoint is rolled back and the occurrence queued with the reason. Any other error fails the user's run, which is logged and tried again on the next one.
- Creating or changing a schedule checks its transaction with `transactions.Check`, the same rules as `Create` without recording. `checkRule` checks the repeat on its own, for `Service.Preview` (`POST /schedules/preview`).
- `CreateRecordingFirst` (`?record_first=true`) records occurrence 0 with `RecordIn` in the create's own transaction, not a savepoint, so a failure saves nothing, and adds its `applied` occurrence row. An approve schedule records it too (it's entered as done); the frontend sends `record_first` from New transaction and New schedule, not from Make recurring. Plain `Create` sets `next_index` to 0 when occurrence 0 passed at most `FirstGrace` (an hour) ago, so the scheduler handles it like any due one.
- `transactions.Service.load` fills a transaction's `ScheduleID` from `schedule_occurrences.transaction_id` (`ListSchedulesFor`).
- Frontend: `lib/schedules.ts` holds the form's repeat values, the request bodies and the sentence (`repeatSentence`); `TransactionForm` takes a `schedule` prop for the schedule pages, and its *Repeat or schedule* switch in New transaction saves with `record_first`.
- `queue.go` approves and skips (#155). `Approve` takes `ledger.LockUser`, then the occurrence `FOR UPDATE`; one that isn't queued is `ErrResolved` (409 `already_resolved`). It records the schedule's transaction, or the edited one from the request, with `RecordIn` in the same database transaction, then marks the occurrence `applied` (`ResolveOccurrence` only changes a queued row). A failure saves nothing, so the occurrence stays queued. Without an edited transaction it's dated at `scheduled_at` when that has passed and the active cycle (`start_at ≤ t < end_at`) contains it, else now. An approve schedule's occurrences are handled `due_days` days (of 24 hours) before their time (`handleFrom`, and the same offset in `UsersWithDueSchedules` and `DueSchedulesForUpdate`), queued with `due_at` at their time. `UpcomingAll` merges `Rule.Upcoming` of every schedule that isn't paused or ended.
- Frontend: `components/schedules/ApprovalQueue.tsx` is the queue on the Scheduled tab, `QueueBadge.tsx` the counts (from `useQueue`, polled every minute), `pages/ApproveScheduled.tsx` *Edit and approve* (`TransactionForm`'s `approve` prop), and `components/dashboard/ScheduledWidget.tsx` the widget. Bulk actions use `useResolveMany`, which sends one request at a time and refreshes once.

### Notifications

Notifications (#57, spec §9) live in `internal/notifications` and aren't stored: `Service.List` works them out from the user's data each time, so one goes away by itself once its task is done. It reads the queued occurrences (`QueueSummary`), the schedules (`schedules.Service.List` and `Rule.Upcoming`), the investment and fund accounts without a BLA since the active cycle started (`AccountsToAdjust`; an account counts as existing before then if it was made before it or has an earlier transaction, since `created_at` is the real time and transactions follow the business clock) and the buckets (`buckets.Service.List`, for TF and CAF).
- Only dismissals are stored, by key, in `notification_dismissals`. A key names what the notification is about (`queue:<newest occurrence>`, `bill:<schedule>:<unix time>`, `balance:<cycle>:<account>`, `bucket:<bucket>`), so it stays hidden until something new happens. `List` deletes dismissals whose notification no longer applies (`ForgetDismissals`), but only for kinds switched on, as the others weren't worked out.
- `Dismiss` only takes a key that's in the list now (else 404), dismissed or not.
- The settings are `preferences.notifications` (nil fields mean on, and bills 3 days ahead), read by the service with `NotificationSettings`.
- Frontend: `api/notifications.ts` polls the list every minute; `useRefreshMoney` and preference changes refresh it. `components/notifications/notificationText.ts` words each kind, `NotificationBadge.tsx` is the side menu item and the mobile bell, `NotificationsCard.tsx` the Settings card, and `pages/Notifications.tsx` the screen.

### User data export

Settings → *Data* (#36) downloads all of a user's data as one JSON file (`GET /api/v1/me/export`) and imports such a file (`POST /api/v1/me/import`, the file as it is, up to 64 MB), which replaces everything the user has. The frontend downloads the current data first and asks for the username (`components/DataCard.tsx`, `api/userdata.ts`). The code is in `internal/userdata`, shared with the debug snapshots:

- **What's in it:** every per-user table (`tables` in `userdata.go`: accounts, cycles, buckets, tags, transactions and their lines and tags, refills, schedules with their lines and queue, notification dismissals) and the preferences, which hold the dashboard, saved modules and report templates. Not the login, sessions, links or logs. Rows are decoded with `UseNumber`, so amounts stay exact; the file is never parsed as floats on the way back either.
- **The format:** a file has `app`, `format` (`userdata.Format`), the schema version, when and by whom it was exported, and the data. `write` inserts each table with the columns the file has, so a column added later gets its default and older files still import. A column the table doesn't have is refused (`invalid_export`), and a newer format is 409 `export_too_new`. When a column is renamed, removed or changes meaning, or the preferences change shape, bump `Format` and teach `upgrade` to convert older files (format 2, #201: `upgrade` turns a format-1 file's saved graphs and graph widgets into saved modules and module widgets with `internal/preferences`, as migration 00024 did the database); `TestColumns` lists every exported column, so a schema change fails it until you've looked.
- **Importing:** in one transaction, under the user's ledger lock: the user's own file keeps its IDs when they're free, anything else gets new IDs (`remap.go`; `TestIDColumns` checks its ID columns against the schema's keys, and the account, bucket and cycle IDs in the preferences' dashboard, saved modules and report templates, sections included, follow). The ledger is immutable, but `ledger_immutable()` lets row deletes through while `bucky.replacing_user_data` is `on` (migration 00023), which `Replace` sets for its transaction only; updates and truncates stay refused. Afterwards, `allocation.Run` recomputes the funds allocations. The handlers log `data.exported` and `data.imported` with counts.

### Report PDFs

*Export PDF* on a report (#127) posts the report on screen, its name and the browser's language, locale and time zone to `POST /api/v1/reports/pdf`. The server (`internal/httpapi/report_pdf.go`) checks it, makes a **render token** for the user (`auth.StartRender`: 32 random bytes, kept as a hash in memory for at most `RenderTTL`, 2 minutes, and ended when the render returns) and has `internal/pdf` drive a headless Chrome over DevTools (chromedp):

- a new tab with the time zone and locale emulated, a light `prefers-color-scheme`, a 703 px wide viewport (A4 less 12 mm margins, `PRINT_WIDTH` in `lib/print.ts`) and the token in an `X-Bucky-Render` header on every request;
- it opens `<PDF_APP_URL>/print/report#<job>`, where the job is base64url JSON (`printJob`: the request plus `generated_at`). A fragment isn't sent to the server, so it's in no log;
- it waits up to a minute for `[data-print-ready]` (or fails on `[data-print-error]`), and prints to A4 with a page number in the footer. At most two renders run at once; more get 429 `too_many_renders`. Chrome missing is 503 `pdf_unavailable`, a page that fails or times out 502 `pdf_failed`. The handler gets a longer write deadline than the server's 30 s (`longWrites`).
- it prints with an outline (`PDFOutlineAndTagged`): bookmarks from the page's headings. In print mode, only the report's name (h1), the modules (h2) and a transactions module's sections (h3) are headings. If the page has a table of contents (`[data-print-toc]`, #193), it is printed twice. `pdf.outline` reads the first PDF's outline with pdfcpu (each heading's title and page, depth first), and the marks go to the page in a `bucky:print-pages` event. The page matches them to its lines in order (`matchPages`), fills in the numbers, whose column had its width from the start, and sets `[data-print-paged]`. Then it is printed again in the same tab. If that fails, the first PDF (links, no numbers) is returned with a `pdf.paginate_failed` warning.

`Sessions` (`session.go`) takes a render token instead of a cookie and gives a session marked `Render`: anything but GET and HEAD is 403 `read_only`, and the gate refuses admin routes even for an admin. DevTools refuses a `Host` header that isn't an IP address or `localhost`, so `pdf.devtoolsURL` resolves Chrome's host name first.

The print page (`pages/PrintReport.tsx`, outside the app's shell and its session guard) reads the job, applies its language and locale, and renders a cover and the modules in **print mode** (`PrintMode` in `lib/print.ts`): no buttons or links (`ReportLink`, `TransactionRow` without `to`), every page of a transactions module, and charts without animation. `usePrintReady` sets `data-print-ready` once nothing has fetched for 300 ms, or `data-print-error` if a query failed. `PrintReport.css` keeps a module on one page when it fits and breaks long ones between rows.

**In development**, run Chrome from the dev compose file and let it reach Vite through the Docker bridge:

1. `docker compose --profile pdf up -d chrome` (DevTools on `127.0.0.1:9222`).
2. In `.env`, uncomment `PDF_CHROME_URL=http://127.0.0.1:9222`, `PDF_APP_URL=http://host.docker.internal:5173` and `VITE_HOST=0.0.0.0`. Vite then listens on every interface instead of only localhost, so the container reaches it through the Docker bridge, and it accepts the `host.docker.internal` host name. Keep opening the app at `http://localhost:5173`: the session cookie is `Secure`, which browsers allow over plain HTTP only on localhost. Your firewall decides whether the LAN can reach port 5173 too.
3. Restart `make dev`. Chrome's console goes to its log (`docker compose --profile pdf logs chrome`): the place to look when an export times out. With firewalld, Docker already puts its bridges in the `docker` zone, which lets them in.

### Debug settings

In development, the bug icon next to the user block (on mobile, in the profile menu) opens the **debug settings** (#100). Any logged-in user can use them.

- **Simulated time:** moves the clock for the whole server, running on from the set moment or frozen, with shortcuts (+1 hour/day/week/month, to the active cycle's end). The accounts, buckets, cycles, refill and transactions services use it (`main.go` passes `debug.Clock.Now` as their `Now`), and so does the frontend (`lib/clock.ts`), so "today", overdue cycles and the latest pickable time agree with the server. Auth keeps the real time, so jumping ahead doesn't end sessions. The database's own `now()` stays real too; it only fills audit columns (`created_at`, `modified_at`). The setting is kept in the database (`debug_clock`), so it survives air's rebuilds; a violet banner shows while it isn't the real time.
- **Snapshots:** save all of your data (accounts, cycles, buckets, tags, transactions and their lines, refills and preferences) under a name, and restore it later. Restoring your own snapshot keeps its IDs. Someone else's, or an imported file, is restored as a copy with new IDs (`userdata/remap.go`, as for the data import). Restore can also set the clock to when the snapshot was taken. Export downloads a snapshot as JSON, and import reads one back, e.g. to share a scenario. A snapshot only restores at the schema version it was taken at.
- **How restore works:** as the data import does (`userdata.Replace`, see *User data export*): it deletes and re-inserts the user's rows with the ledger's delete allowed for that transaction, so it needs no superuser. The stored CAF, cycle states and refills come back as they were, so nothing is recomputed.
- **Only in development builds:** `internal/debug` is linked only with `-tags debug` (`cmd/server/debug_on.go`; `debug_off.go` is the real clock and no routes), and only `APP_ENV=development` turns it on. air, `make test` and `make lint` use the tag; the Dockerfile doesn't, and `make debug-tag-check` (also in CI) fails if a production build links the package. Its tables (`debug_clock`, `debug_snapshots`) are created at start, not by migrations, so production databases never have them. The routes (`/api/dev/…`) are outside the OpenAPI spec and check the session themselves. The frontend loads `components/debug` only when `import.meta.env.DEV`, so production bundles drop it.

After pulling this change, restart `make dev`: air only reads `.air.toml` when it starts.

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

All UI text is translated: English, Norwegian bokmål and nynorsk (`src/i18n/`).
- Text lives in `src/i18n/locales/en.json`, `nb.json` and `nn.json`, under the same keys. Components get it with `const { t } = useTranslation()` and `t("cycles.end")`; code outside components uses `i18n.t` from `@/i18n`. Keys are typed from `en.json`, so a missing key fails the typecheck. `locales.test.ts` checks that nb and nn have every English key, with the same placeholders.
- A new text goes into all three files. Counts use plural keys (`daysLeft_one`, `daysLeft_other`) with `t("cycles.daysLeft", { count })`. Text with markup, such as bold or a link, uses `<Trans>` with tags like `<b>` in the text.
- The words for the domain (bøtte, periode, påfyll, …) are in `src/i18n/README.md`. Keep new text consistent with them.
- `lib/language.ts` picks the language. The `language` preference wins; null follows the locale (`nb-NO` gives bokmål, `nn-NO` nynorsk, any other English), and without a locale, the browser's language. The guard applies it with `applyLanguage()` and remounts the screens, as it does for the locale. The login page uses the last language used in that browser.
- API errors are translated by their `code` (`errors.codes` in the resources), through `describeError()` and `errorMessage()`. For a code without a translation, the server's (English) `detail` is shown.
- Tests run in English. To check another language, a test switches with `i18n.changeLanguage()` or a preference, and `setup.ts` switches back afterwards.

Money is never a JS `number`. The API sends and receives amounts as decimal strings (`"1234.50"`):
- `formatMoney()` formats one exactly, in NOK or the currency given (an account's or bucket's).
- `addAmounts()`, `subtractAmounts()` and `compareAmounts()` calculate with them exactly, in BigInt cents.
- `<AmountInput>` takes what the user types (`1 234,5`) and emits the canonical string, or `null` if the input is invalid.
- API dates (`YYYY-MM-DD`) go through `lib/dates.ts`, so they don't shift a day in other time zones.

Cycles are picked as local dates, but the API takes timestamps (spec §3). `lib/cycles.ts` does the conversion:
- `startAtFor(date)` is the UTC moment of that date's local midnight.
- `endAtFor(lastDay)` is the next local midnight, since `end_at` is exclusive.
- `firstDay()` and `lastDay()` convert back.

The End cycle confirmation previews the OVF and REF with `lib/cycleEnd.ts`. It mirrors the routines in `internal/refill/refill.go`, so a change to one needs the same change in the other. The per-bucket refill rule is `refillOf()` in `lib/buckets.ts`, which the Buckets screen also uses for the amount on its Refill button.

`lib/buckets.ts` also has what the Buckets screen works out from a bucket and its account: how much of TF the account doesn't cover, whether the bucket is overspent and the warning tone (`coverage`), the usage bar's color (`usageColor`), the account's totals (`accountSummary`), and the breakdown of the cycle's budget (`breakdownText`).

The Create transaction screen keeps its rules in `lib/transactionForm.ts`: the bucket split's totals and the pre-fill for a new row, whether the time is inside the active cycle, the "Triggers refill" default (`ruleMatches` mirrors `refill.Triggers` on the backend), and what picking an earlier counterparty fills in (`fromLastTime`). Editing reuses the same form (`components/transactions/TransactionForm.tsx` with `editing`): `editState` gives its start values and `correctionBody` the correction with only what changed.

The Transactions screen keeps its rules in `lib/transactionList.ts`: the filters as URL parameters (`readFilter`, `withFilter`; no `cycle_id` means the active cycle, `cycle_id=all` every cycle), the API query they make (`listQuery`), the day groups, a row's amount, and whether a transaction's bucket lines are locked (`bucketLinesLocked`, as the ledger checks).

Budget setup keeps its rules in `lib/budget.ts`: the edited values (`BudgetDraft`, only what changed, so the saved values show through), an account's totals against its expected income (`accountBudget`), a bucket's capacity after an RA change (`capacityAfter`, mirroring `settings.check` in `internal/buckets`), and what Save sends (`budgetChanges`). With *Also change this cycle*, `cycleChanges` previews the TF change per bucket and what each account is short afterwards; it mirrors `SetRefillAmounts` in `internal/buckets` (a BUA for each refilled bucket), so change both together.

The Buckets screen's *Transactions* dialog (`components/buckets/BucketHistory.tsx`) gets every line on the bucket in a cycle (`useBucketTransactions`, all types, up to 10 pages of 200) and works out the rows with `lib/bucketHistory.ts`: `historyRows` counts what's left back from the bucket figures' `left`, so the rows stay right when older pages are missing, and `ofKind` narrows them. `BREAKDOWN_KIND` maps the breakdown's parts to the types they open (`UsedThisCycle` takes `onPart`; without it, as on the Dashboard, the breakdown is plain text).

The Buckets screen's *Adjust funds* dialog (`components/buckets/AdjustFunds.tsx`) previews with `lib/bucketAdjust.ts` (`adjustPreview`, `movePreview`), which mirror `Adjust` and `Transfer` in `internal/buckets`; change both together. A *Fully manual* bucket's *Add funds* and *Remove funds* (`components/buckets/FundsButtons.tsx`) are temporary adjustments, previewed with `fundsPreview` and checked with `fundsProblem` against its capacity (`checkCapacity` in `internal/buckets`). A move between buckets on one account takes CAF along in `allocation.Follow` (`moveAlong`).

The Dashboard's rules are in `lib/dashboard.ts`: its layouts (#37, #99), each a list of `WidgetInstance`s with their own settings (`dashboardLayout` reads the desktop one from `preferences.dashboard.widgets`, or makes `defaultLayout` from #29's per-type settings; `dashboardLayouts` adds the mobile one from `mobile_widgets`, else a `copyLayout` of the desktop one, else `defaultLayout("mobile")`; `layoutsToPreferences` makes what to save, always both layouts, since the API replaces `dashboard` as a whole), the edits (`moveWidget`, `moveWidgetTo`, `removeWidget`, `replaceWidget`, `newWidget`, `settingsComplete`), the title (`autoTitle`, `customTitle`; `titleFor` and `useWidgetTitle` in `components/dashboard/frame.ts` add the widget's name), the health per account (`accountHealth`), which buckets Bucket status shows (`needsAttention`, `mostUsed`), and the account or bucket a widget shows, falling back when it's gone (`shownAccounts`, `shownBucketStatus`). The widgets are in `components/dashboard/`, one file per type. `WidgetView` picks the type and owns its settings dialog (`WidgetSettings.tsx`, also used by *Add widget*), and `DashboardGrid` lays them out, with `@dnd-kit` sorting and the edit bar in edit mode (`WidgetFrame` in `frame.ts` gives `WidgetCard` its title, and in edit mode tells it to show the bar and make the content inert). The page shows the layout for the screen (the `sm` breakpoint, as the app shell), keeps a draft of both layouts while editing, whichever one the *Desktop | Mobile* switch shows (`DashboardGrid`'s `narrow` gives the mobile one a single column), and saves both with Done; outside edit mode a settings change is saved at once, to the shown layout. The In/out widget's rules are in `lib/flows.ts`: a period's local days (`periodSpan`, with the locale's `weekStart`), the totals from the per-account flows (`flowTotals`) and the Transactions link for a figure (`flowLink`). Its figures come from `useAccountFlows` (`GET /api/v1/reports/flows`, under the transactions query key so money changes refresh it), which sums each account's INC, EXP and TRF per transaction family in SQL (`AccountFlows`, `balance.Flows`). The Module widget (#201, `ModuleWidget.tsx`; the Graph widget before, #124) shows a saved module by id over its own period (`savedModulePeriods`): a graph module as `GraphView` with `clickThrough={false}` (no bar, point or slice links) and its comparison, inside a box that opens `savedModuleLink(saved)` on Stats; other types, compact (#203, `settings.view`, the default), as `CompactModule.tsx`: a transactions module's count and totals from `useTransactionSummary` (`GET /api/v1/transactions/summary`, `transactions.Service.Summary`, which pages through the list's matches with the list's own query building, `listParams`, and sums them as `sectionSummary` in `lib/transactionTable.ts` does) and its 3 newest rows; an in/out/balance module's account totals from `flowTables` in `FlowFigures` (the In/out widget's figures, which pick their layout by what fits) and its top buckets by Out; a budget module's `budgetRows` over `budgetSummary`, as `CompactBucket`s (`components/buckets/BucketParts.tsx`, shared with Bucket status). Full is `ModuleBody` (`components/reports/ModuleCard.tsx`; its `average`, off in a section's parts through `ModuleCard`'s `inSection`, says whether an in/out/balance or budget module shows its average, #220) with `breakdown={false}`, for a graph too. The widget's options (`ModuleWidgetSettings` in `lib/dashboard.ts`: `showPeriod`, `graphHeight` with `GRAPH_PX`, and `transactions`, `flows` and `budget`, each from the API's nested objects) are written by `moduleToApi` only where they differ from `fromApi.module()`'s defaults; `ModuleForm` in `WidgetSettings.tsx` shows those for the picked saved module's type. `addModuleWidget` and `moduleWidgetsFor` (`lib/dashboard.ts`) back *Add to dashboard* and the delete warning in `SavedModules.tsx`; a layout with a widget type the app doesn't know skips it. It shares `components/buckets/BucketParts.tsx` with Buckets and `components/transactions/TransactionRow.tsx` with Transactions.

Graphs, widgets and reports pick their time span with `lib/periods.ts` (#120): a `PeriodChoice` (the last N days, weeks, cycles, months, quarters, half-years or years; one specific day, week, cycle, month, quarter, half-year or year, by its first day or the cycle's ID, with `specificAt` and `stepSpecific`; this or the previous day, week, cycle, month, quarter, half-year or year; or custom dates) that `formatPeriod`/`parsePeriod` keep in the URL or settings, and `resolvePeriod` turns into local days and UTC moments now (This … runs to now; a custom one ends today at the latest), and `wholePeriod` gives the days it covers once it's over. `applicableResolutions` offers every resolution whose interval is no longer than the whole period (a cycle counts as a month at most), per hour and for the whole period always; `defaultResolution`, `keptResolution` and `coarser` pick one. `intervalCount` counts the intervals the Stats API will cut, as it cuts them, so a graph's `fitResolution` (`lib/graphs.ts`) goes coarser past its limit (`MAX_BARS` = 60 for bars, `MAX_POINTS` = 1000, the API's cap) or its width. `components/stats/PeriodPicker.tsx` and `ResolutionPicker.tsx` are the shared pickers, and `useStatsSeries` (`api/stats.ts`, under the transactions query key) fetches a series with the browser's time zone and the locale's `weekStart`.

Stats & reports (`pages/Stats.tsx`, #122) has a *Stats* tab (*Graphs* before #204, at `/stats`) and a *Reports* tab (`/stats/reports`, below). The Stats tab's `StatsScreen` takes its type from the saved module picked (`saved`), else `type` in the URL (`ModuleTypeSwitch.tsx`), and keeps `period` for every type (`show` writes the graph's params with that period). A graph is the graph screen; another type is `ModuleView` (`components/stats/SavedModuleView.tsx`): a saved one through `SavedModuleView`, which holds its draft, and a new one from `newSavedModule` (`lib/savedModules.ts`), whose module the page keeps per type while it's open (`drafts`) and whose period is written to the URL. Clearing or deleting a saved one hands its draft back, so it stays as an unsaved one. A graph's settings are `GraphSettings` (`api/openapi.yaml`, shared with the graph widget, #124) and their rules are in `lib/graphs.ts`: the URL form (`graphToSearch`, `graphFromSearch`; `cleanGraph` drops defaults and what doesn't apply, so `sameGraph` compares clean forms), the Stats API query (`statsQuery`; one account counts its transfers), the currency drawn (`shownCurrency`, #90's rule), the rows and series for `@mantine/charts` (`graphData`: names, the top N plus *Other*, running totals, interval labels), how fine a graph can be (`fitResolution`: no more intervals than it draws, and those fit its width; `showDots`), the Y range for *Fit to data* (`yDomain`: padded and rounded, stacked bars by their totals) and the Transactions link for a bar, point or slice (`intervalLink`). Pies (#123) are a third `kind`: `pieSlicing` says whether they slice per bucket, per account or (unsplit) per interval, `queryResolution` asks for the whole period for the first two, and `pieData` makes the slices (the bar graph's naming, top N and *Other* via `graphData`, without what's at or below 0) with their shares; `components/stats/PieView.tsx` draws the donut with a list, labels (`pie_labels`) or both. Rates and averages (#182) are in `lib/graphRates.ts`: `intervalDays` (local calendar days, a started day whole), `unitDays` (the unit's days for `show_as`; a cycle the mean of the overlapping cycles), `wholeInterval` (not cut by the period or now), `rateAmounts` (per unit, or a running average) and `averageOf`; `compareGraphData`, `graphData` and `pieData` take a last `GraphRate` argument (`{ unitDays, cycles }`) and scale what they draw, and `compareGraphData` returns the average lines (`averages`, `averageOf`) when `average` is on. `components/stats/GraphView.tsx` measures its width, fetches and draws (the average lines as Recharts reference lines); `GraphControls.tsx` holds the settings (a drawer on mobile); `SavedModules.tsx` saves what's on screen in the `saved_modules` preference (#201; the server checks unique ids, names and the module, and that it isn't a section; imports remap their account and bucket IDs). A saved module's rules are in `lib/savedModules.ts`: `readSavedModules`, `savedModuleReport` (it as a report of one module, to show and edit it as one), `savedModulePeriods` (`periodsOf` in `lib/reports.ts`, which takes the last N too: `previousPeriod` compares them through `previousLast`, each end moved back N units or a year and the end kept before this period's start, and the last N cycles against the N started before), `graphAsSaved` (the graph on screen with the comparison on screen, keeping the picked one's breakdown and title; `graphCompare` is a saved one's comparison, which the URL's `compare` and `compare_to` override only where they differ, set in `components/stats/GraphCompareFields.tsx` under the period), `fromReportModule` (*Save module…* in a report, `components/reports/SaveModuleDialog.tsx`, with the report's filters baked in), `toReportModule` (*Copy a saved module* in `ModuleEditor`) and `savedModuleOptions` (grouped by type). One that isn't a graph opens in `components/stats/SavedModuleView.tsx`: a `PeriodPicker` with every period and the title, then `ModuleFields` (`components/reports/ModuleEditor.tsx`: the editor's fields for that type, applied as they change, its filters saying *all*, not *the report's*) in a panel, or a drawer on phones, and `ModuleBody`. The palette is in `components/stats/graphs.css`: twelve colour-blind-checked slots in a fixed order with their own dark steps (bars and lines use the first eight; pies per interval go up to 12, and since a pie wraps from its last slice to its first, a 7-slice pie uses slot 10 for its seventh, as slot 7 is too close to slot 1), and a recessive grey for *Other* that clears slots 1–8; the series shown are coloured in name order, not by size, so a colour doesn't jump when the amounts change.

Reports (#125) are `ReportSettings` (a period limited to years, half-years, quarters, months, cycles and custom dates; `compare_to`; report filters; `ReportModule`s of a `type`: a `graph` module's `graph` is a `ReportGraph`, i.e. `GraphSettings` without the period, a `transactions` module (#126) has `ReportTransactions`, its filters, types and whether it shows system types and reversed ones, and a `flows` module has `ReportFlows`: accounts, buckets, what it shows, transfers, details and its breakdown, and a `budget` module has `ReportBudget`: accounts, buckets and `per_cycle`). The frontend reads them by type (`readTemplates` gives `GraphModule | TransactionsModule | FlowsModule | BudgetModule`). Their rules are in `lib/reports.ts`: the built-in `STARTERS`, `moduleGraph` (the report's period, and its filters where the module sets none), `previousPeriod` (right before or a year earlier, a cycle always the one before, cut to the elapsed length while the period runs), `subPeriods` (months or overlapping cycles, clipped, with the 60-day and 24-part limits), `partResolution` (a small graph's resolution when the module's would give one interval), `moduleTransactions`/`transactionsQuery`/`transactionsLink`/`groupTransactions` (a transactions module's filters, its list query, the Transactions screen link, null while a filter has several values, #162, and its headings per day, week, month or cycle), `moduleFlows`/`flowsQuery`/`flowTables` (an in/out/balance module's accounts and buckets, its Stats query, and its rows for one interval, without rows that are all 0, with a total per currency), `flowAverages` (#220: those rows summed over the whole parts from `periodParts` at the average's unit and ÷ their number with `divideAmount` in `lib/money.ts`, as `BUCKET_AVERAGE`/`ACCOUNT_DETAILS` rows with a change; `FlowsModule` reuses the breakdown's query when the units match, and `FlowGrid`'s `average` draws them without balances or links), `budgetAverage` (the same per cycle over `budgetRows`, the active cycle left out), `moduleBudget`/`periodCycles`/`budgetRows`/`budgetSummary` (a budget module's accounts and buckets, the begun cycles with most of their days in the period, half counting where the cycle starts, else the one with the most, whole, marked partial or active, a cycle's bucket figures as rows, Budget without `capped`, Unspent = Budget − Used, Carried over = `left`, with used % and totals per currency, and the cycles' figures as one: the first start, each later cycle's budget without the positive funds it brought along, all used, the last left). The bucket figures split `overflow` into `capped` (a refill's OVF above BC, found by `refills.ovf_id`, with its reversals) and `swept` (the cycle end's) and `cleanReport`/`sameReport`. A compared graph is `compareGraphData` in `lib/graphs.ts`: the series and colours are the current period's, the previous period's values come from the series with the same name (the rest into *Other*), lined up by position; *Both* adds `<name>-prev` series (dashed lines, lighter bars stacked per period), *Difference* subtracts. `GraphView` takes a `compare` prop and fetches the previous period at the same resolution. The screen is `components/reports/`: `ReportTemplates` (starters and saved templates, `?starter=` or `?template=` in the URL), `ReportView` (period, compare-to and filters, in a drawer on mobile, then the modules: `ReportBuilder`'s rows by default, #202, or the cards in full with `view=report`; `ModuleActions` gives both their buttons, with Preview, Move to… and, on phones, a ⋯ menu in the builder; `moveTargets`, `moveModuleTo` and `removeModule` in `lib/reports.ts` keep the limits; the rows sort with `components/SortableList.tsx`, a dnd-kit list per list, so a drag never leaves its section; a section's preview is `SectionParts`, the accordion `SectionCard` shows), `ModuleCard` (a graph; `TransactionsModule`: `useTransactionPages` with `TransactionRow`, 50 at a time; or `FlowsModule`: `useStatsFlows` for the whole period and, broken down, per month or cycle, matched to `subPeriods` by their start; or `BudgetModule`: `useBucketFiguresFor`, the cycles' `GET /api/v1/cycles/{id}/bucket-figures` under the same keys as `useBucketFigures`) and `ModuleEditor` (the type when adding; `GraphControls` with `reportPeriod`, which hides the period picker; the filter fields are `components/stats/FilterFields.tsx`). Templates are the `report_templates` preference: the server checks unique template and module ids, names, and that a module has its type's settings and not the other's (`checkReportTemplates`), and the data import (#36) remaps their cycle, account and bucket IDs, a transactions, in/out/balance or budget module's filters too (`remapGraph` in `userdata/remap.go`).

Phones (#103): iOS Safari zooms in on a focused field whose text is under 16px, and stays zoomed. `src/styles/global.css` therefore gives Mantine's fields 16px on touch screens and narrow widths, so new fields need nothing extra. Dialogs and drawers allow pinch-zoom (`theme.ts`). To focus a field when a dialog opens, spread `{...autofocusField()}` from `lib/device.ts` instead of writing `data-autofocus`. It does nothing on touch screens, so the keyboard doesn't pop up over the dialog.

On the backend, `buckets` can't import `refill` (it's the other way round), so `refill.Service.OnCreate` reaches bucket creation through the `buckets.Options.OnCreate` hook, wired in `cmd/server/main.go`.

The time zone preference is set to the browser's zone the first time a user has none (`useDefaultTimeZone` in `app/session.ts`). The cycle rule's Settings card is `components/cycles/CycleRuleCard.tsx`, with its helpers in `lib/cycleRule.ts`. *Plan a cycle* and the start prompt suggest the rule's dates through `useCyclePeriods` (`api/cycles.ts`).

Tests run in jsdom. `src/test/render.tsx` has helpers that render a component with the app's providers (the real query client, minus retries), or the whole app at a given path. `viewport.width` from `src/test/setup.ts` switches between the desktop and mobile layouts, and `viewport.touch` makes it a touch screen.

Tests never reach a server. `src/test/fixtures.ts` builds sample accounts and buckets. `src/test/api.ts` is a fake backend that `setup.ts` installs as `fetch`. By default it answers as a logged-in normal user, `testUser`, with a time zone set; a test that changes the user's preferences keeps `...testUser.preferences`, or the guard sets the zone. A test changes an answer with `apiMock.on("PATCH /api/v1/me/preferences", { body: … })`, or with a function of the request; `problem(status, code, detail)` builds an error. The test then checks what was sent with `apiMock.calls(route)`. The answers reset after each test.

## Versions and What's New

The app's version is `vX.YY.ZZ` (zero-padded):
- **X** goes up when a milestone is done (1 = MVP), and YY and ZZ go back to 00.
- **YY** goes up for a new feature, and ZZ goes back to 00.
- **ZZ** goes up for a bugfix or a minor change, including development-only features.

Every PR bumps the version by one step. It adds an entry at the top of `CHANGELOG` in `source/frontend/src/lib/changelog.ts`: the new version, the date it's merged (`yyyy-mm-dd`), a title, and the changes in en, nb and nn. The PR description says `Version: vX.YY.ZZ`. If another PR merges first, renumber yours. `lib/changelog.test.ts` checks that each version is one step after the one before, with dates in order and text in every language.

- The newest entry is the app's version (`APP_VERSION`); no other file has it.
- What's New shows each entry as `<title> (yyyy-mm-dd) - vX.YY.ZZ`.
- It pops up on a feature or major version (`isFeatureUpdate`), not a patch, so a patch's entry shows in the next feature version's popup.
- The commit comes from `vite.config.ts` as `__APP_COMMIT__`: `GIT_COMMIT` when set (the image build passes `BUCKY_COMMIT` through), else `git rev-parse --short HEAD`. The server binary gets the same commit (`main.commit`) for its first log line.
- *Development* in About is `import.meta.env.DEV`, which is true on the Vite dev server and in tests.
- `testUser` has seen the current version, so the popup doesn't open over other tests.

## Workflow and CI

- Work on a branch and merge to `main` through a pull request. Each PR bumps the version and adds its What's New entry (see above). The repo is private on GitHub's free plan, which doesn't enforce branch protection, so this is a convention: **merge only when CI is green**.
- `.github/workflows/ci.yml` runs on every PR and on every push to `main`. It has four jobs:
  - **Backend:** `go mod verify`, `go vet` (with and without the `debug` tag), golangci-lint, then `go test -race -tags debug` against a PostgreSQL service container, the debug tag check, then a build.
  - **Frontend:** `npm ci`, ESLint, `tsc`, Vitest and `vite build`.
  - **API contract:** `make lint-spec` and `make generate-check`, which fails if the committed generated code is out of date.
  - **Production image:** builds the Dockerfile (nothing is pushed) and checks `deploy/compose.yaml` with `docker compose config`, with and without the tailnet.
- To reproduce CI locally, run `make lint test generate-check`.
- Dependabot (`.github/dependabot.yml`) opens weekly PRs for Go modules, npm, GitHub Actions, the Dockerfile's base images and the Compose images. Minor and patch updates are grouped, and a release must be a week old first.
  - Actions are pinned to commit SHAs. Dependabot updates the SHA and its version comment together.
  - A few versions are outside Dependabot's reach and are bumped by hand. They're listed at the top of `dependabot.yml`.

## Troubleshooting

- **`permission denied … /var/run/docker.sock`**: you haven't logged out and back in since being added to the `docker` group. As a temporary fix, run `newgrp docker` in the current shell.
- **`docker` talks to Podman**: don't install `podman-docker`. It provides a conflicting `docker` command. Podman itself can stay installed.
- **`docker` points at a stale Docker Desktop context**: run `docker context use default`.
