-- Credit card accounts (#260, spec §2.2): an optional default account (where
-- debt no bucket budgeted is set aside, and what the bill is paid from,
-- unless chosen otherwise), the credit limit, the statement and due days
-- (1–28, or 31 for the last day of the month) and the fixed minimum payment.
-- Set only on credit cards; all but the default account are required there.

-- +goose Up
ALTER TABLE bank_accounts
    ADD COLUMN card_default_account_id text,
    ADD COLUMN card_credit_limit numeric(14,2) CHECK (card_credit_limit > 0),
    ADD COLUMN card_statement_day smallint CHECK (card_statement_day BETWEEN 1 AND 28 OR card_statement_day = 31),
    ADD COLUMN card_due_day smallint CHECK (card_due_day BETWEEN 1 AND 28 OR card_due_day = 31),
    ADD COLUMN card_minimum_payment numeric(14,2) CHECK (card_minimum_payment > 0),
    ADD CONSTRAINT bank_accounts_card_default_account_fkey
        FOREIGN KEY (card_default_account_id, user_id) REFERENCES bank_accounts (id, user_id),
    ADD CONSTRAINT bank_accounts_card_check CHECK (
        (account_type = 'credit_card') = (card_credit_limit IS NOT NULL AND card_statement_day IS NOT NULL
            AND card_due_day IS NOT NULL AND card_minimum_payment IS NOT NULL)
        AND (card_default_account_id IS NULL OR account_type = 'credit_card')
    );
CREATE INDEX bank_accounts_card_default_account_idx ON bank_accounts (card_default_account_id)
    WHERE card_default_account_id IS NOT NULL;

-- +goose Down
DROP INDEX bank_accounts_card_default_account_idx;
ALTER TABLE bank_accounts
    DROP CONSTRAINT bank_accounts_card_check,
    DROP CONSTRAINT bank_accounts_card_default_account_fkey,
    DROP COLUMN card_minimum_payment,
    DROP COLUMN card_due_day,
    DROP COLUMN card_statement_day,
    DROP COLUMN card_credit_limit,
    DROP COLUMN card_default_account_id;
UPDATE bank_accounts SET account_type = 'usage' WHERE account_type = 'credit_card';
