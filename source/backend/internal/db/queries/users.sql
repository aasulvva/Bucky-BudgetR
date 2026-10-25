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
