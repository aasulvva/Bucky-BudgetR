-- Users and their login sessions (spec §1). Timestamps are UTC (timestamptz).

-- +goose Up
CREATE TABLE users (
    id                   text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{5}$'), -- ids.User
    username             text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{3,32}$'),
    password_hash        text NOT NULL,
    active               boolean NOT NULL DEFAULT true,
    admin                boolean NOT NULL DEFAULT false,
    must_change_password boolean NOT NULL DEFAULT false,
    preferences          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(preferences) = 'object'),
    created_at           timestamptz NOT NULL DEFAULT now(),
    modified_at          timestamptz NOT NULL DEFAULT now(),
    created_by           text REFERENCES users (id)
);

-- Usernames are unique regardless of case.
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

-- Server-side sessions. The cookie holds a random token; only its SHA-256
-- is stored, so the table can't be used to hijack sessions.
CREATE TABLE sessions (
    token_hash   bytea PRIMARY KEY CHECK (length(token_hash) = 32),
    user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL,
    user_agent   text NOT NULL DEFAULT '',
    ip           text NOT NULL DEFAULT ''
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- +goose Down
DROP TABLE sessions;
DROP TABLE users;
