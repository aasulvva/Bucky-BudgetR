-- Counting a purchase in its bucket later (#264, spec §5.5): a Deferred
-- Bucket Charge (DBC) is when the bucket takes it, and a waiting charge says
-- when that is. A new enum value can't be used in the transaction that adds
-- it, so the tables are in the next migration.

-- +goose Up
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'DBC';
CREATE TYPE waiting_charge_when AS ENUM ('paid', 'cycle', 'month');

-- +goose Down
-- As in 00037, DBC stays in the enum, unused.
DROP TYPE waiting_charge_when;
