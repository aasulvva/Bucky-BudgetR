-- The Fully manual refill mode (#76): a bucket that is never refilled, whose
-- funds only change through adjustments, and that may have no capacity.
-- A new enum value can't be used in the transaction that adds it, so the
-- constraints that use them are in the next migration.

-- +goose Up
ALTER TYPE refill_mode ADD VALUE 'fully_manual';
ALTER TYPE bucket_cap_mode ADD VALUE 'none';

-- +goose Down
-- Postgres can't drop an enum value: the types are recreated without them,
-- after the buckets that use them become Manual with a ×1 capacity.
UPDATE buckets SET refill_mode = 'manual' WHERE refill_mode = 'fully_manual';
UPDATE buckets SET cap_mode = 'multiplier', cap_multiplier = 1 WHERE cap_mode = 'none';

ALTER TYPE refill_mode RENAME TO refill_mode_old;
CREATE TYPE refill_mode AS ENUM ('auto', 'manual', 'on_income');
ALTER TABLE buckets
    ALTER COLUMN refill_mode DROP DEFAULT,
    ALTER COLUMN refill_mode TYPE refill_mode USING refill_mode::text::refill_mode,
    ALTER COLUMN refill_mode SET DEFAULT 'auto';
ALTER TABLE refills
    DROP CONSTRAINT refills_check,
    ALTER COLUMN trigger TYPE refill_mode USING trigger::text::refill_mode,
    ADD CONSTRAINT refills_check CHECK ((trigger = 'on_income') = (income_id IS NOT NULL));
DROP TYPE refill_mode_old;

ALTER TABLE buckets DROP CONSTRAINT buckets_cap_check;
ALTER TYPE bucket_cap_mode RENAME TO bucket_cap_mode_old;
CREATE TYPE bucket_cap_mode AS ENUM ('multiplier', 'fixed');
ALTER TABLE buckets
    ALTER COLUMN cap_mode DROP DEFAULT,
    ALTER COLUMN cap_mode TYPE bucket_cap_mode USING cap_mode::text::bucket_cap_mode,
    ALTER COLUMN cap_mode SET DEFAULT 'multiplier',
    ADD CONSTRAINT buckets_cap_check CHECK (
        (cap_mode = 'multiplier' AND cap_multiplier IS NOT NULL AND cap_amount IS NULL)
        OR (cap_mode = 'fixed' AND cap_amount IS NOT NULL AND cap_multiplier IS NULL));
DROP TYPE bucket_cap_mode_old;
