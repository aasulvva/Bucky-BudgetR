-- name: CreateSession :exec
INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
VALUES (sqlc.arg(token_hash), sqlc.arg(user_id), sqlc.arg(now), sqlc.arg(now), sqlc.arg(expires_at),
        sqlc.arg(user_agent), sqlc.arg(ip));

-- name: GetSessionWithUser :one
SELECT sqlc.embed(sessions), sqlc.embed(users)
FROM sessions
JOIN users ON users.id = sessions.user_id
WHERE sessions.token_hash = $1;

-- name: TouchSession :exec
UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id = $1;

-- name: DeleteOtherUserSessions :exec
-- Revokes every session of the user except the one making the request.
DELETE FROM sessions WHERE user_id = $1 AND token_hash <> sqlc.arg(keep);

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions
WHERE expires_at <= sqlc.arg(now) OR last_seen_at <= sqlc.arg(idle_cutoff);
