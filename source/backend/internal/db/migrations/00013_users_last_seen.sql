-- When each user last used the app (spec §1), for the Admin screen. Kept on
-- the user rather than read from sessions, which end on logout, a reset, a
-- deactivation or the cleanup. Null until the user logs in.

-- +goose Up
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

UPDATE users
SET last_seen_at = s.last_seen_at
FROM (SELECT user_id, max(last_seen_at) AS last_seen_at FROM sessions GROUP BY user_id) s
WHERE users.id = s.user_id;

-- +goose Down
ALTER TABLE users DROP COLUMN last_seen_at;
