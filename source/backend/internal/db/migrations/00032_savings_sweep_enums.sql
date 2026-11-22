-- The savings budget's sweeps (#235, spec §8.6): two more modes, after the
-- refills and at cycle end. A new enum value can't be used in the
-- transaction that adds it, so the table changes are in the next migration.

-- +goose Up
ALTER TYPE savings_budget_when ADD VALUE IF NOT EXISTS 'after_refills';
ALTER TYPE savings_budget_when ADD VALUE IF NOT EXISTS 'cycle_end';

-- +goose Down
-- As in 00025, the values stay, unused: the next migration's Down deletes
-- the entries that have them, and Up adds them only if they're missing.
SELECT 1;
