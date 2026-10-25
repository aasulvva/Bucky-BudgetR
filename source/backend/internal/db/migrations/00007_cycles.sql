-- A user's cycles never overlap (spec §3). Cycles run from start_at up to,
-- but not including, end_at, so one may start exactly when another ends.
-- btree_gist lets the exclusion constraint compare user_id with =.

-- +goose Up
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE cycles ADD CONSTRAINT cycles_no_overlap
    EXCLUDE USING gist (user_id WITH =, tstzrange(start_at, end_at) WITH &&);

-- +goose Down
ALTER TABLE cycles DROP CONSTRAINT cycles_no_overlap;
-- The extension is left in place: other objects may use it.
