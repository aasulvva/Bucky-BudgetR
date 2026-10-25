-- The rest of the bucket (spec §4): refill amount, capacity, allocation and
-- refill settings, and rules on its name. The bucket's currency is its source
-- account's; the API only lets the source change to an account in the same
-- currency.

-- +goose Up
CREATE TYPE bucket_cap_mode AS ENUM ('multiplier', 'fixed');
CREATE TYPE refill_mode AS ENUM ('auto', 'manual', 'on_income');
CREATE TYPE overflow_destination AS ENUM ('unallocated', 'savings_distribution', 'savings_target');

ALTER TABLE buckets
    ADD COLUMN refill_amount        numeric(14, 2) NOT NULL DEFAULT 0 CHECK (refill_amount >= 0),
    -- BC is refill_amount × cap_multiplier, or cap_amount. Only the field the
    -- mode uses is set, and BC is never below RA.
    ADD COLUMN cap_mode             bucket_cap_mode NOT NULL DEFAULT 'multiplier',
    ADD COLUMN cap_multiplier       numeric(6, 2) DEFAULT 1 CHECK (cap_multiplier >= 1),
    ADD COLUMN cap_amount           numeric(14, 2) CHECK (cap_amount >= refill_amount),
    -- Current Available Funds, maintained by the Money Allocation Routine (#17).
    ADD COLUMN caf                  numeric(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN keep_funds           boolean NOT NULL DEFAULT false,
    ADD COLUMN refill_mode          refill_mode NOT NULL DEFAULT 'auto',
    ADD COLUMN overflow_destination overflow_destination NOT NULL DEFAULT 'unallocated',
    ADD COLUMN priority             boolean NOT NULL DEFAULT false,
    ADD COLUMN importance           smallint NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
    ADD CONSTRAINT buckets_cap_check CHECK (
        (cap_mode = 'multiplier' AND cap_multiplier IS NOT NULL AND cap_amount IS NULL)
        OR (cap_mode = 'fixed' AND cap_amount IS NOT NULL AND cap_multiplier IS NULL)),
    ADD CONSTRAINT buckets_name_check CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100);

-- Names are unique per user, ignoring case, among buckets that aren't deleted.
CREATE UNIQUE INDEX buckets_user_name_key ON buckets (user_id, lower(name)) WHERE NOT deleted;

-- +goose Down
DROP INDEX buckets_user_name_key;
ALTER TABLE buckets
    DROP CONSTRAINT buckets_name_check,
    DROP CONSTRAINT buckets_cap_check,
    DROP COLUMN importance,
    DROP COLUMN priority,
    DROP COLUMN overflow_destination,
    DROP COLUMN refill_mode,
    DROP COLUMN keep_funds,
    DROP COLUMN caf,
    DROP COLUMN cap_amount,
    DROP COLUMN cap_multiplier,
    DROP COLUMN cap_mode,
    DROP COLUMN refill_amount;
DROP TYPE overflow_destination;
DROP TYPE refill_mode;
DROP TYPE bucket_cap_mode;
