-- Card debt held per account (#261, spec §2.2): two system types, CDH (Card
-- Debt Hold) sets debt that isn't held aside on an account, CDR (Card Debt
-- Release) gives it back. A new enum value can't be used in the transaction
-- that adds it, so the table is in the next migration.

-- +goose Up
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'CDH';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'CDR';

-- +goose Down
-- As in 00025, the values stay, unused: the next migration's Down deletes
-- the transactions that have them, and Up adds them only if they're missing.
SELECT 1;
