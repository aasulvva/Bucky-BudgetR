-- What a refill does with a negative TF (an overspent bucket, #62). It only
-- matters with Keep funds: without it the refill always sets TF to RA.
-- 'debt' adds RA as usual, so the overspend is paid back from the refill;
-- 'clear' brings TF to 0 first.

-- +goose Up
CREATE TYPE negative_tf AS ENUM ('debt', 'clear');
ALTER TABLE buckets ADD COLUMN negative_tf negative_tf NOT NULL DEFAULT 'debt';

-- +goose Down
ALTER TABLE buckets DROP COLUMN negative_tf;
DROP TYPE negative_tf;
