-- The savings module's transaction types (#231, spec §5.4): SVR (savings
-- reserve), SVC (savings cancel) and SVB (savings to bucket). A new enum value
-- can't be used in the transaction that adds it, so the tables that use them
-- are in the next migration.

-- +goose Up
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'SVR';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'SVC';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'SVB';

-- +goose Down
-- Postgres can't drop an enum value, and recreating transaction_type would
-- mean rebuilding every constraint that names one. The values stay, unused:
-- the next migration's Down deletes the transactions that have them, and Up
-- adds them only if they're missing.
SELECT 1;
