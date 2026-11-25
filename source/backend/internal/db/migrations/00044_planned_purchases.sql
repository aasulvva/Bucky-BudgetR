-- Planned purchases (#265, spec §5.7): something like a pre-order, charged
-- later on a soft date. In the cycle of its expected date (or the active
-- cycle, once that's gone by) its bucket parts are a figure, set aside for
-- it: no lines, the buckets' money isn't touched. Recording its charge is an
-- ordinary expense that closes it.

-- +goose Up
CREATE TYPE planned_purchase_status AS ENUM ('open', 'charged', 'cancelled');

CREATE TABLE planned_purchases (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{15}$'), -- ids.PlannedPurchase
    user_id        text NOT NULL REFERENCES users (id),
    -- The name or store: the expense's counterparty once it's charged.
    name           text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 200),
    account_id     text NOT NULL,
    amount         numeric(14, 2) NOT NULL CHECK (amount > 0),
    -- When it's expected to be charged: the start of the expected day, as
    -- the client gives it.
    expected_at    timestamptz NOT NULL,
    note           text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    status         planned_purchase_status NOT NULL DEFAULT 'open',
    -- The expense that recorded its charge.
    transaction_id text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    CHECK (left(id, 6) = user_id),
    CHECK ((status = 'charged') = (transaction_id IS NOT NULL)),
    FOREIGN KEY (account_id, user_id) REFERENCES bank_accounts (id, user_id),
    FOREIGN KEY (transaction_id, user_id) REFERENCES transaction_headers (id, user_id)
);

CREATE INDEX planned_purchases_user_id_idx ON planned_purchases (user_id, expected_at);
CREATE INDEX planned_purchases_transaction_id_idx ON planned_purchases (transaction_id);

CREATE TABLE planned_purchase_bucket_lines (
    planned_id text NOT NULL,
    bucket_id  text NOT NULL,
    user_id    text NOT NULL REFERENCES users (id),
    amount     numeric(14, 2) NOT NULL CHECK (amount > 0),
    -- The order they were given in.
    position   integer NOT NULL,
    PRIMARY KEY (planned_id, bucket_id),
    FOREIGN KEY (planned_id, user_id) REFERENCES planned_purchases (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (bucket_id, user_id) REFERENCES buckets (id, user_id)
);

CREATE INDEX planned_purchase_bucket_lines_bucket_id_idx ON planned_purchase_bucket_lines (bucket_id);

-- +goose Down
DROP TABLE planned_purchase_bucket_lines;
DROP TABLE planned_purchases;
DROP TYPE planned_purchase_status;
