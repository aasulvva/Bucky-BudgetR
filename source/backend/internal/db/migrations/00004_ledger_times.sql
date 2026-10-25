-- Transactions and cycle boundaries are moments in time, stored as UTC
-- timestamptz. The UI converts a cycle's local start and end dates to the
-- UTC moments of local midnight (01.11 in Oslo starts at 31.10 23:00 UTC).
--
-- A cycle runs from start_at up to, but not including, end_at. A
-- transaction's ID starts with its UTC date.

-- +goose Up
ALTER TABLE transaction_headers DROP CONSTRAINT transaction_headers_check;
DROP INDEX transaction_headers_user_date_idx;
ALTER TABLE transaction_headers RENAME COLUMN transaction_date TO transaction_at;
ALTER TABLE transaction_headers
    ALTER COLUMN transaction_at TYPE timestamptz USING transaction_at::timestamp AT TIME ZONE 'UTC',
    ADD CONSTRAINT transaction_headers_id_date_check
        CHECK (left(id, 8) = to_char(transaction_at AT TIME ZONE 'UTC', 'YYYYMMDD'));
CREATE INDEX transaction_headers_user_at_idx ON transaction_headers (user_id, transaction_at);

ALTER TABLE cycles DROP CONSTRAINT cycles_check1;
ALTER TABLE cycles RENAME COLUMN start_date TO start_at;
ALTER TABLE cycles RENAME COLUMN end_date TO end_at;
ALTER TABLE cycles
    ALTER COLUMN start_at TYPE timestamptz USING start_at::timestamp AT TIME ZONE 'UTC',
    -- The old end date was the cycle's last day; end_at is the moment after it.
    ALTER COLUMN end_at TYPE timestamptz USING (end_at + 1)::timestamp AT TIME ZONE 'UTC',
    ADD CONSTRAINT cycles_start_end_check CHECK (start_at < end_at);

-- +goose Down
ALTER TABLE cycles DROP CONSTRAINT cycles_start_end_check;
ALTER TABLE cycles
    ALTER COLUMN start_at TYPE date USING (start_at AT TIME ZONE 'UTC')::date,
    ALTER COLUMN end_at TYPE date USING ((end_at - interval '1 microsecond') AT TIME ZONE 'UTC')::date;
ALTER TABLE cycles RENAME COLUMN start_at TO start_date;
ALTER TABLE cycles RENAME COLUMN end_at TO end_date;
ALTER TABLE cycles ADD CONSTRAINT cycles_check1 CHECK (start_date <= end_date);

DROP INDEX transaction_headers_user_at_idx;
ALTER TABLE transaction_headers DROP CONSTRAINT transaction_headers_id_date_check;
ALTER TABLE transaction_headers
    ALTER COLUMN transaction_at TYPE date USING (transaction_at AT TIME ZONE 'UTC')::date;
ALTER TABLE transaction_headers RENAME COLUMN transaction_at TO transaction_date;
ALTER TABLE transaction_headers
    ADD CONSTRAINT transaction_headers_check CHECK (left(id, 8) = to_char(transaction_date, 'YYYYMMDD'));
CREATE INDEX transaction_headers_user_date_idx ON transaction_headers (user_id, transaction_date);
