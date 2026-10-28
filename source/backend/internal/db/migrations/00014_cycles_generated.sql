-- Whether the cycle rule (#72) planned a cycle. Moving a planned cycle by
-- hand clears it, so a rule change replans only the cycles nobody touched.

-- +goose Up
ALTER TABLE cycles ADD COLUMN generated boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE cycles DROP COLUMN generated;
