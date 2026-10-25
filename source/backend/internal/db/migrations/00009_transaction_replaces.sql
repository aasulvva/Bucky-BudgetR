-- A transaction moved to another account is reversed and recorded again
-- (spec §5): the new original points to the one it replaces. Adding a column
-- doesn't fire the immutability triggers; rows are still never updated.

-- +goose Up
ALTER TABLE transaction_headers
    ADD COLUMN replaces_id text,
    -- Only originals replace another transaction, of the same user.
    ADD CONSTRAINT transaction_headers_replaces_check CHECK (replaces_id IS NULL OR correction_type = 'none'),
    ADD CONSTRAINT transaction_headers_replaces_fkey
        FOREIGN KEY (replaces_id, user_id) REFERENCES transaction_headers (id, user_id);

CREATE INDEX transaction_headers_replaces_id_idx ON transaction_headers (replaces_id);

-- +goose Down
DROP INDEX transaction_headers_replaces_id_idx;
ALTER TABLE transaction_headers
    DROP CONSTRAINT transaction_headers_replaces_fkey,
    DROP CONSTRAINT transaction_headers_replaces_check,
    DROP COLUMN replaces_id;
