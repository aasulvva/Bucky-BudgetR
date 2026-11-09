-- name: InsertLogEntries :copyfrom
INSERT INTO log_entries (at, level, kind, message, event, request_id, user_id, attrs)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListLogEntries :many
-- Newest first, before the cursor (an entry ID). q is a LIKE pattern, escaped
-- by the caller, matched against the message, the event and the attributes.
SELECT e.id, e.at, e.level, e.kind, e.message, e.event, e.request_id, e.user_id, e.attrs,
       u.username
FROM log_entries e
LEFT JOIN users u ON u.id = e.user_id
WHERE (sqlc.narg(kind)::text IS NULL OR e.kind = sqlc.narg(kind)::text)
  AND (sqlc.narg(min_level)::smallint IS NULL OR e.level >= sqlc.narg(min_level)::smallint)
  AND (sqlc.narg(from_at)::timestamptz IS NULL OR e.at >= sqlc.narg(from_at)::timestamptz)
  AND (sqlc.narg(to_at)::timestamptz IS NULL OR e.at < sqlc.narg(to_at)::timestamptz)
  AND (sqlc.narg(user_id)::text IS NULL OR e.user_id = sqlc.narg(user_id)::text)
  AND (sqlc.narg(request_id)::text IS NULL OR e.request_id = sqlc.narg(request_id)::text)
  AND (sqlc.narg(q)::text IS NULL OR e.message ILIKE sqlc.narg(q)::text
       OR e.event ILIKE sqlc.narg(q)::text OR e.attrs::text ILIKE sqlc.narg(q)::text)
  AND (sqlc.narg(before)::bigint IS NULL OR e.id < sqlc.narg(before)::bigint)
ORDER BY e.id DESC
LIMIT sqlc.arg(lim);

-- name: DeleteOldLogEntries :execrows
-- Audit entries are kept audit_days; other warnings and errors error_days;
-- the other events event_days.
DELETE FROM log_entries e
USING log_settings s
WHERE (e.kind = 'audit' AND e.at < sqlc.arg(now)::timestamptz - make_interval(days => s.audit_days))
   OR (e.kind <> 'audit' AND e.level >= 4 AND e.at < sqlc.arg(now)::timestamptz - make_interval(days => s.error_days))
   OR (e.kind <> 'audit' AND e.level < 4 AND e.at < sqlc.arg(now)::timestamptz - make_interval(days => s.event_days));

-- name: GetLogSettings :one
SELECT event_days, error_days, audit_days FROM log_settings;

-- name: UpdateLogSettings :one
UPDATE log_settings
SET event_days = sqlc.arg(event_days), error_days = sqlc.arg(error_days), audit_days = sqlc.arg(audit_days)
RETURNING event_days, error_days, audit_days;
