-- Setup and reset links (spec §1): an admin hands a user a link instead of a
-- temporary password, and the user chooses their own password with it. Like
-- sessions, only the token's SHA-256 is stored. A link works once, until it
-- expires; a user has at most one.

-- +goose Up
CREATE TABLE password_links (
    token_hash bytea PRIMARY KEY CHECK (length(token_hash) = 32),
    user_id    text NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    purpose    text NOT NULL CHECK (purpose IN ('setup', 'reset')),
    created_by text REFERENCES users (id),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE password_links;
