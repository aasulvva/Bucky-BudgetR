-- The bank an account is in (#70), up to 100 characters; '' when not given.
-- Register interest uses it as the counterparty.

-- +goose Up
ALTER TABLE bank_accounts
    ADD COLUMN bank text NOT NULL DEFAULT '' CHECK (length(bank) <= 100);

-- +goose Down
ALTER TABLE bank_accounts DROP COLUMN bank;
