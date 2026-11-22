-- What an overflow or savings budget SVR moved on at once (#233, #234).

-- name: CreateFollowOn :exec
INSERT INTO savings_follow_ons (source_id, follow_id, user_id) VALUES ($1, $2, $3);

-- name: ListFollowOns :many
-- Newest first, the order to take them back in.
SELECT follow_id FROM savings_follow_ons
WHERE source_id = $1 AND user_id = $2
ORDER BY created_at DESC, follow_id DESC;
