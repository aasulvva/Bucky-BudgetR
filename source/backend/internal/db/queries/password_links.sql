-- name: CreatePasswordLink :exec
-- Replaces the user's link, if any: a new one voids the old.
INSERT INTO password_links (token_hash, user_id, purpose, created_by, created_at, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(user_id), sqlc.arg(purpose), sqlc.arg(created_by),
        sqlc.arg(now), sqlc.arg(expires_at))
ON CONFLICT (user_id) DO UPDATE
SET token_hash = excluded.token_hash, purpose = excluded.purpose, created_by = excluded.created_by,
    created_at = excluded.created_at, expires_at = excluded.expires_at;

-- name: GetPasswordLink :one
SELECT sqlc.embed(password_links), sqlc.embed(users)
FROM password_links
JOIN users ON users.id = password_links.user_id
WHERE password_links.token_hash = $1;

-- name: TakePasswordLink :one
-- Uses up a link: it works once.
DELETE FROM password_links WHERE token_hash = $1
RETURNING *;

-- name: DeleteUserPasswordLinks :exec
DELETE FROM password_links WHERE user_id = $1;

-- name: DeleteExpiredPasswordLinks :execrows
DELETE FROM password_links WHERE expires_at <= sqlc.arg(now);
