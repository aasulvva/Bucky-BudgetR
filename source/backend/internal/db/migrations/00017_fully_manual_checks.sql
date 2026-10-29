-- A Fully manual bucket (#76) has no refill amount and always keeps its
-- funds. Its capacity is a fixed amount or none ('none'), which no other
-- refill mode may use.

-- +goose Up
ALTER TABLE buckets
    DROP CONSTRAINT buckets_cap_check,
    ADD CONSTRAINT buckets_cap_check CHECK (
        (cap_mode = 'multiplier' AND cap_multiplier IS NOT NULL AND cap_amount IS NULL)
        OR (cap_mode = 'fixed' AND cap_amount IS NOT NULL AND cap_multiplier IS NULL)
        OR (cap_mode = 'none' AND cap_amount IS NULL AND cap_multiplier IS NULL)),
    ADD CONSTRAINT buckets_fully_manual_check CHECK (
        CASE WHEN refill_mode = 'fully_manual'
            THEN refill_amount = 0 AND keep_funds AND cap_mode <> 'multiplier'
            ELSE cap_mode <> 'none'
        END);

-- +goose Down
ALTER TABLE buckets
    DROP CONSTRAINT buckets_fully_manual_check,
    DROP CONSTRAINT buckets_cap_check,
    ADD CONSTRAINT buckets_cap_check CHECK (
        (cap_mode = 'multiplier' AND cap_multiplier IS NOT NULL AND cap_amount IS NULL)
        OR (cap_mode = 'fixed' AND cap_amount IS NOT NULL AND cap_multiplier IS NULL)
        OR cap_mode = 'none');
