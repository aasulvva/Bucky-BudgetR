-- The transaction ledger (spec §5) and the core of the tables it refers to.
-- bank_accounts, cycles and buckets are minimal here; #12, #13 and #14 add
-- their remaining columns. Amounts are NUMERIC(14,2), exchange rates
-- NUMERIC(18,8). Dates without a time (transaction, cycle) are `date`.

-- +goose Up
CREATE TYPE transaction_type AS ENUM (
    'OPB', 'BLA', 'INC', 'EXP', 'TRF', 'INP', 'OPF', 'REF', 'BUA', 'BAT', 'OVF'
);
CREATE TYPE correction_type AS ENUM ('none', 'adjustment', 'reversal');
CREATE TYPE cycle_state AS ENUM ('future', 'active', 'finished');

-- Owned tables have UNIQUE (id, user_id), so other tables can use composite
-- foreign keys to require the same owner.

CREATE TABLE bank_accounts (
    id          text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{3}$'), -- ids.Account
    user_id     text NOT NULL REFERENCES users (id),
    name        text NOT NULL,
    currency    char(3) NOT NULL DEFAULT 'NOK' CHECK (currency ~ '^[A-Z]{3}$'),
    deleted     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id)
);

CREATE TABLE cycles (
    id          text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{11}$'), -- ids.Cycle
    user_id     text NOT NULL REFERENCES users (id),
    start_date  date NOT NULL,
    end_date    date NOT NULL,
    state       cycle_state NOT NULL DEFAULT 'future',
    created_at  timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    CHECK (left(id, 6) = user_id),
    CHECK (start_date <= end_date)
);

-- A user has at most one active cycle (spec §3).
CREATE UNIQUE INDEX cycles_one_active ON cycles (user_id) WHERE state = 'active';

CREATE TABLE buckets (
    id                text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{9}$'), -- ids.Bucket
    user_id           text NOT NULL REFERENCES users (id),
    name              text NOT NULL,
    source_account_id text NOT NULL,
    deleted           boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    modified_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    CHECK (left(id, 6) = user_id),
    -- The source account belongs to the bucket's owner.
    FOREIGN KEY (source_account_id, user_id) REFERENCES bank_accounts (id, user_id)
);

CREATE INDEX buckets_source_account_id_idx ON buckets (source_account_id);

-- Per-user tags. Not part of the immutable ledger, so they can be renamed.
CREATE TABLE tags (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users (id),
    name       text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 50),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id)
);

CREATE UNIQUE INDEX tags_user_name_key ON tags (user_id, lower(name));

-- Ledger rows are immutable: corrections and reversals are new transactions.
-- created_by is NULL for transactions the system creates (OPB, REF, OVF…).

CREATE TABLE transaction_headers (
    id               text PRIMARY KEY CHECK (id ~ '^[0-9]{16}$'), -- ids.Transaction
    user_id          text NOT NULL REFERENCES users (id),
    parent_id        text,
    correction_type  correction_type NOT NULL DEFAULT 'none',
    transaction_type transaction_type NOT NULL,
    transaction_date date NOT NULL,
    counterparty     text NOT NULL DEFAULT '' CHECK (length(counterparty) <= 200),
    created_at       timestamptz NOT NULL DEFAULT now(),
    created_by       text REFERENCES users (id),
    UNIQUE (id, user_id),
    -- The ID starts with the transaction date.
    CHECK (left(id, 8) = to_char(transaction_date, 'YYYYMMDD')),
    -- Only corrections have a parent, which belongs to the same user.
    CHECK ((correction_type = 'none') = (parent_id IS NULL)),
    FOREIGN KEY (parent_id, user_id) REFERENCES transaction_headers (id, user_id)
);

CREATE INDEX transaction_headers_user_date_idx ON transaction_headers (user_id, transaction_date);
CREATE INDEX transaction_headers_parent_id_idx ON transaction_headers (parent_id);

CREATE TABLE bank_transactions (
    id                text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{15}$'), -- ids.BankLine
    transaction_id    text NOT NULL REFERENCES transaction_headers (id),
    account_id        text NOT NULL REFERENCES bank_accounts (id),
    -- In the account's currency; this is the amount that counts (spec §5.2).
    amount            numeric(14, 2) NOT NULL CHECK (amount <> 0),
    -- Foreign-currency purchases, for reference only.
    original_amount   numeric(14, 2) CHECK (original_amount <> 0),
    original_currency char(3) CHECK (original_currency ~ '^[A-Z]{3}$'),
    exchange_rate     numeric(18, 8) CHECK (exchange_rate > 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        text REFERENCES users (id),
    CHECK (left(id, 4) = account_id),
    CHECK ((original_amount IS NULL) = (original_currency IS NULL)
       AND (original_amount IS NULL) = (exchange_rate IS NULL))
);

CREATE INDEX bank_transactions_transaction_id_idx ON bank_transactions (transaction_id);
CREATE INDEX bank_transactions_account_id_idx ON bank_transactions (account_id);

CREATE TABLE bucket_transactions (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{23}$'), -- ids.BucketLine
    transaction_id text NOT NULL REFERENCES transaction_headers (id),
    bucket_id      text NOT NULL REFERENCES buckets (id),
    cycle_id       text NOT NULL REFERENCES cycles (id),
    amount         numeric(14, 2) NOT NULL CHECK (amount <> 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text REFERENCES users (id),
    CHECK (left(id, 10) = bucket_id),
    -- The bucket and the cycle belong to the same user.
    CHECK (left(bucket_id, 6) = left(cycle_id, 6))
);

CREATE INDEX bucket_transactions_transaction_id_idx ON bucket_transactions (transaction_id);
CREATE INDEX bucket_transactions_bucket_id_idx ON bucket_transactions (bucket_id);
CREATE INDEX bucket_transactions_cycle_id_idx ON bucket_transactions (cycle_id);

CREATE TABLE transaction_tags (
    transaction_id text NOT NULL,
    tag_id         bigint NOT NULL,
    user_id        text NOT NULL,
    PRIMARY KEY (transaction_id, tag_id),
    FOREIGN KEY (transaction_id, user_id) REFERENCES transaction_headers (id, user_id),
    FOREIGN KEY (tag_id, user_id) REFERENCES tags (id, user_id)
);

CREATE INDEX transaction_tags_tag_id_idx ON transaction_tags (tag_id);

-- +goose StatementBegin
CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is immutable: record a correction or reversal instead', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER transaction_headers_immutable BEFORE UPDATE OR DELETE ON transaction_headers
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER transaction_headers_no_truncate BEFORE TRUNCATE ON transaction_headers
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER bank_transactions_immutable BEFORE UPDATE OR DELETE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER bank_transactions_no_truncate BEFORE TRUNCATE ON bank_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER bucket_transactions_immutable BEFORE UPDATE OR DELETE ON bucket_transactions
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER bucket_transactions_no_truncate BEFORE TRUNCATE ON bucket_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER transaction_tags_immutable BEFORE UPDATE OR DELETE ON transaction_tags
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER transaction_tags_no_truncate BEFORE TRUNCATE ON transaction_tags
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- +goose Down
DROP TABLE transaction_tags;
DROP TABLE bucket_transactions;
DROP TABLE bank_transactions;
DROP TABLE transaction_headers;
DROP FUNCTION ledger_immutable();
DROP TABLE tags;
DROP TABLE buckets;
DROP TABLE cycles;
DROP TABLE bank_accounts;
DROP TYPE cycle_state;
DROP TYPE correction_type;
DROP TYPE transaction_type;
