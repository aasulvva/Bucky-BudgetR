-- Counting a purchase in its bucket later (#264, spec §5.5). An expense's
-- bucket parts can wait instead of taking the buckets' money at once: each
-- part is a waiting line (+) on its bucket, an advance the bucket owes its
-- account, so unallocated doesn't change. A Deferred Bucket Charge (DBC)
-- later takes it, in parts or at once: a bucket line (−) like an expense's
-- and a waiting line (−) that pays the advance back. What a bucket still
-- owes for a purchase is the sum of their waiting lines.
--
-- waiting_charges says when each part is taken: as the card purchase is paid
-- off (paid), at a planned cycle's start (cycle), or at the start of the
-- first cycle that starts in or after a month (month). It's the user's
-- choice, so it can change; the lines can't.

-- +goose Up
CREATE TABLE waiting_charges (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{23}$'), -- ids.WaitingCharge
    user_id        text NOT NULL REFERENCES users (id),
    -- The purchase: an original expense.
    transaction_id text NOT NULL REFERENCES transaction_headers (id),
    bucket_id      text NOT NULL REFERENCES buckets (id),
    "when"         waiting_charge_when NOT NULL,
    -- The planned cycle of a cycle charge; null once that cycle is deleted
    -- (replanned), when take_on stands in for it.
    cycle_id       text REFERENCES cycles (id) ON DELETE SET NULL,
    -- From the start of which cycle a cycle or month charge is due: the
    -- cycle's start date, or the month's first day. Null when paid.
    take_on        date,
    created_at     timestamptz NOT NULL DEFAULT now(),
    modified_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, bucket_id),
    CHECK (left(id, 10) = bucket_id),
    CHECK (("when" = 'paid') = (take_on IS NULL)),
    CHECK ("when" = 'cycle' OR cycle_id IS NULL)
);

CREATE INDEX waiting_charges_user_id_idx ON waiting_charges (user_id);
CREATE INDEX waiting_charges_cycle_id_idx ON waiting_charges (cycle_id);

CREATE TABLE waiting_lines (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{23}$'), -- ids.WaitingLine
    transaction_id text NOT NULL REFERENCES transaction_headers (id),
    -- The purchase it waits for (the original expense), and its bucket.
    purchase_id    text NOT NULL REFERENCES transaction_headers (id),
    bucket_id      text NOT NULL REFERENCES buckets (id),
    amount         numeric(14, 2) NOT NULL CHECK (amount <> 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text REFERENCES users (id),
    CHECK (left(id, 10) = bucket_id)
);

CREATE INDEX waiting_lines_transaction_id_idx ON waiting_lines (transaction_id);
-- Covering, so what a bucket owes per purchase is a cheap sum.
CREATE INDEX waiting_lines_purchase_id_idx ON waiting_lines (purchase_id, bucket_id) INCLUDE (amount);
CREATE INDEX waiting_lines_bucket_id_idx ON waiting_lines (bucket_id) INCLUDE (amount);

CREATE TRIGGER waiting_lines_immutable BEFORE UPDATE OR DELETE ON waiting_lines
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER waiting_lines_no_truncate BEFORE TRUNCATE ON waiting_lines
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- +goose Down
-- The DBC transactions go too (with the ledger's delete switch, see 00023).
-- Purchases stay, without their waiting lines.
SELECT set_config('bucky.replacing_user_data', 'on', true);
DROP TABLE waiting_lines;
DROP TABLE waiting_charges;
DELETE FROM transaction_tags tt USING transaction_headers h
WHERE h.id = tt.transaction_id AND h.transaction_type = 'DBC';
DELETE FROM bucket_transactions l USING transaction_headers h
WHERE h.id = l.transaction_id AND h.transaction_type = 'DBC';
DELETE FROM transaction_headers WHERE transaction_type = 'DBC' AND parent_id IS NOT NULL;
DELETE FROM transaction_headers WHERE transaction_type = 'DBC';
SELECT set_config('bucky.replacing_user_data', 'off', true);
