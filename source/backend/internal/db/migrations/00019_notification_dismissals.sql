-- Notifications (#57) are worked out from the user's data when read, so only
-- dismissals are stored: the key of each notification the user dismissed or
-- marked done. A key names what the notification is about, e.g.
-- 'bucket:4829131234'. Dismissals of notifications that no longer apply are
-- deleted when the list is read, so the notification shows again if it
-- comes back.

-- +goose Up
CREATE TABLE notification_dismissals (
    user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key          text NOT NULL CHECK (key <> '' AND length(key) <= 200),
    dismissed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

-- +goose Down
DROP TABLE notification_dismissals;
