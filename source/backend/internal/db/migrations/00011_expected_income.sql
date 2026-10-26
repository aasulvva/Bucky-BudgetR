-- Budget setup (spec §9): the income the user expects on a source account per
-- cycle, to compare the buckets' refill amounts with. Null until entered.

-- +goose Up
ALTER TABLE bank_accounts
    ADD COLUMN expected_income numeric(14, 2) CHECK (expected_income >= 0);

-- +goose Down
ALTER TABLE bank_accounts DROP COLUMN expected_income;
