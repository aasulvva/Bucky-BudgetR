-- name: CreateUser :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO users (id, username, password_hash, admin, must_change_password, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO NOTHING
RETURNING id;

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByUsername :one
SELECT * FROM users WHERE lower(username) = lower(sqlc.arg(username));

-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: UpdatePassword :exec
UPDATE users
SET password_hash = $2, must_change_password = false, modified_at = now()
WHERE id = $1;

-- name: UpdatePreferences :one
-- Merges patch into the stored preferences; null values remove a key.
UPDATE users
SET preferences = jsonb_strip_nulls(preferences || sqlc.arg(patch)::jsonb), modified_at = now()
WHERE id = sqlc.arg(id)
RETURNING preferences;

-- name: ListUsers :many
SELECT * FROM users ORDER BY lower(username);

-- name: LastSeenByUser :many
-- When each user's sessions were last used; users without one are left out.
SELECT user_id, max(last_seen_at)::timestamptz AS last_seen_at
FROM sessions
GROUP BY user_id;

-- name: GetUserForUpdate :one
SELECT id, active, admin FROM users WHERE id = $1 FOR UPDATE;

-- name: CountOtherActiveAdmins :one
SELECT count(*) FROM users WHERE active AND admin AND id <> sqlc.arg(id)::text;

-- name: UpdateUserFlags :exec
UPDATE users SET active = $2, admin = $3, modified_at = now() WHERE id = $1;

-- name: SetTemporaryPassword :execrows
-- A password the user must change at their next login.
UPDATE users
SET password_hash = $2, must_change_password = true, modified_at = now()
WHERE id = $1;

-- name: RecoverUser :one
-- The CLI's rescue: a temporary password, and the user active and admin.
UPDATE users
SET password_hash = sqlc.arg(password_hash), must_change_password = true, active = true, admin = true,
    modified_at = now()
WHERE lower(username) = lower(sqlc.arg(username))
RETURNING id;
