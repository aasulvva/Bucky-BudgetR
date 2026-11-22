-- Bucket overflow to savings (#233, spec §8.5): a bucket whose overflow goes
-- to a savings target names it. The FK is deferred because a bucket and its
-- target refer to each other: export/import writes buckets before savings
-- holders and deletes them the other way round.

-- +goose Up
ALTER TABLE buckets
    ADD COLUMN overflow_target_id text,
    ADD CONSTRAINT buckets_overflow_target_fkey FOREIGN KEY (overflow_target_id, user_id)
        REFERENCES savings_holders (id, user_id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT buckets_overflow_target_check CHECK (
        (overflow_destination = 'savings_target') = (overflow_target_id IS NOT NULL));

CREATE INDEX buckets_overflow_target_id_idx ON buckets (overflow_target_id) WHERE overflow_target_id IS NOT NULL;

-- +goose Down
-- Overflow goes back to unallocated. OVF savings lines stay: the money they
-- hold is still reserved, and older versions read them like any other.
UPDATE buckets SET overflow_destination = 'unallocated'
WHERE overflow_destination <> 'unallocated';

ALTER TABLE buckets
    DROP CONSTRAINT buckets_overflow_target_check,
    DROP COLUMN overflow_target_id;
