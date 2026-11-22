-- Savings targets and the money held for them (#231, spec §8).
--
-- A savings holder is a savings target (a Fully manual bucket or a savings,
-- BSU, fund or investment account, with a goal) or the user's savings
-- distributor (#232). Money for savings stays in its source account, reserved
-- there: savings lines record it, beside bank and bucket lines. What a holder
-- has reserved on an account is the sum of its lines there.

-- +goose Up
CREATE TYPE savings_holder_kind AS ENUM ('target', 'distributor');

CREATE TABLE savings_holders (
    id          text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{9}$'), -- ids.SavingsHolder
    user_id     text NOT NULL REFERENCES users (id),
    kind        savings_holder_kind NOT NULL,
    -- A target is a bucket or an account; the distributor is neither.
    bucket_id   text,
    account_id  text,
    -- NULL shows the bucket's or account's name.
    name        text CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
    goal        numeric(14, 2) CHECK (goal > 0),
    note        text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    deleted     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    CHECK (left(id, 6) = user_id),
    FOREIGN KEY (bucket_id, user_id) REFERENCES buckets (id, user_id),
    FOREIGN KEY (account_id, user_id) REFERENCES bank_accounts (id, user_id),
    CONSTRAINT savings_holders_kind_check CHECK (
        (kind = 'target' AND (bucket_id IS NULL) <> (account_id IS NULL) AND goal IS NOT NULL)
        OR (kind = 'distributor' AND bucket_id IS NULL AND account_id IS NULL AND goal IS NULL AND name IS NULL))
);

CREATE INDEX savings_holders_user_id_idx ON savings_holders (user_id);
-- A bucket or account is one target at most, and a user has one distributor.
CREATE UNIQUE INDEX savings_holders_bucket_key ON savings_holders (bucket_id) WHERE NOT deleted AND bucket_id IS NOT NULL;
CREATE UNIQUE INDEX savings_holders_account_key ON savings_holders (account_id) WHERE NOT deleted AND account_id IS NOT NULL;
CREATE UNIQUE INDEX savings_holders_distributor_key ON savings_holders (user_id) WHERE kind = 'distributor';

-- Savings lines. Part of the immutable ledger, like bank and bucket lines.
CREATE TABLE savings_transactions (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{23}$'), -- ids.SavingsLine
    transaction_id text NOT NULL REFERENCES transaction_headers (id),
    holder_id      text NOT NULL REFERENCES savings_holders (id),
    -- The source account, where the money is reserved.
    account_id     text NOT NULL REFERENCES bank_accounts (id),
    -- The cycle the line's time falls in, if any.
    cycle_id       text REFERENCES cycles (id),
    amount         numeric(14, 2) NOT NULL CHECK (amount <> 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text REFERENCES users (id),
    CHECK (left(id, 10) = holder_id),
    -- The holder and the cycle belong to the same user.
    CHECK (cycle_id IS NULL OR left(holder_id, 6) = left(cycle_id, 6))
);

CREATE INDEX savings_transactions_transaction_id_idx ON savings_transactions (transaction_id);
-- Covering, so what's held per holder and account is a cheap sum.
CREATE INDEX savings_transactions_holder_id_idx ON savings_transactions (holder_id, account_id) INCLUDE (amount);
CREATE INDEX savings_transactions_account_id_idx ON savings_transactions (account_id) INCLUDE (amount);
CREATE INDEX savings_transactions_cycle_id_idx ON savings_transactions (cycle_id);

CREATE TRIGGER savings_transactions_immutable BEFORE UPDATE OR DELETE ON savings_transactions
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER savings_transactions_no_truncate BEFORE TRUNCATE ON savings_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- +goose Down
-- The savings transactions go too (with the ledger's delete switch, see
-- 00023): their types stay in the enum (00025), unused. A transfer that did
-- Done on held funds stays as a plain transfer.
SELECT set_config('bucky.replacing_user_data', 'on', true);
DELETE FROM transaction_tags tt USING transaction_headers h
WHERE h.id = tt.transaction_id AND h.transaction_type IN ('SVR', 'SVC', 'SVB');
DELETE FROM bank_transactions l USING transaction_headers h
WHERE h.id = l.transaction_id AND h.transaction_type IN ('SVR', 'SVC', 'SVB');
DELETE FROM bucket_transactions l USING transaction_headers h
WHERE h.id = l.transaction_id AND h.transaction_type IN ('SVR', 'SVC', 'SVB');
DROP TABLE savings_transactions;
DELETE FROM transaction_headers WHERE transaction_type IN ('SVR', 'SVC', 'SVB') AND parent_id IS NOT NULL;
DELETE FROM transaction_headers WHERE transaction_type IN ('SVR', 'SVC', 'SVB');
SELECT set_config('bucky.replacing_user_data', 'off', true);
DROP TABLE savings_holders;
DROP TYPE savings_holder_kind;
