-- Credit card accounts (#260, spec §2.2). A new enum value can't be used in
-- the transaction that adds it, so the columns are in the next migration.

-- +goose Up
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'credit_card';

-- +goose Down
-- As in 00025, the value stays, unused: the next migration's Down turns
-- cards into usage accounts, and Up adds it only if it's missing.
SELECT 1;
