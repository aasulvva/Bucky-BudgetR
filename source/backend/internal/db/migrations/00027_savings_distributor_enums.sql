-- The savings distributor's enums (#232, spec §8): the SVD (savings
-- distribution) transaction type and the distributor's hold modes. A new enum
-- value can't be used in the transaction that adds it, so the tables that use
-- them are in the next migration.

-- +goose Up
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'SVD';
CREATE TYPE savings_hold_mode AS ENUM ('immediate', 'minimum', 'manual');

-- +goose Down
-- As in 00025, SVD stays in transaction_type, unused: the next migration's
-- Down deletes the transactions that have it, and Up adds it only if it's
-- missing.
DROP TYPE savings_hold_mode;
