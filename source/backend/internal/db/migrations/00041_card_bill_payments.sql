-- Paying a card's bill (#262, spec §2.2). Finalizing the bill fixes its
-- statement and schedules the payment: a one-off schedule tied to the
-- statement, which pays what's left of it when it runs (full), the minimum
-- left (minimum), or a fixed amount, at most what's left (fixed). Each card
-- has defaults for it, and auto-finalize finalizes on the payment day with
-- them, paying from the card's default account.

-- +goose Up
CREATE TYPE card_pay_rule AS ENUM ('full', 'minimum', 'fixed');

ALTER TABLE bank_accounts
    ADD COLUMN card_pay_rule card_pay_rule,
    ADD COLUMN card_pay_amount numeric(14, 2) CHECK (card_pay_amount > 0),
    -- Paid on the due date (0) or this many days before.
    ADD COLUMN card_pay_days_before smallint CHECK (card_pay_days_before BETWEEN 0 AND 14),
    ADD COLUMN card_pay_mode schedule_mode,
    ADD COLUMN card_auto_finalize boolean;

UPDATE bank_accounts
SET card_pay_rule = 'full', card_pay_days_before = 0, card_pay_mode = 'approve', card_auto_finalize = false
WHERE account_type = 'credit_card';

ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_card_pay_check CHECK (
    (account_type = 'credit_card') = (card_pay_rule IS NOT NULL AND card_pay_days_before IS NOT NULL
        AND card_pay_mode IS NOT NULL AND card_auto_finalize IS NOT NULL)
    AND (card_pay_amount IS NOT NULL) = (card_pay_rule IS NOT DISTINCT FROM 'fixed')
    AND (card_auto_finalize IS NOT TRUE OR card_default_account_id IS NOT NULL)
);

ALTER TABLE schedules
    ADD COLUMN card_statement_id text REFERENCES card_statements (id),
    ADD COLUMN bill_rule card_pay_rule,
    ADD CONSTRAINT schedules_bill_check CHECK (
        (card_statement_id IS NULL) = (bill_rule IS NULL)
        AND (card_statement_id IS NULL OR (transaction_type = 'TRF' AND left(card_statement_id, 4) = to_account_id))
    );
CREATE INDEX schedules_card_statement_idx ON schedules (card_statement_id) WHERE card_statement_id IS NOT NULL;

-- +goose Down
DROP INDEX schedules_card_statement_idx;
ALTER TABLE schedules
    DROP CONSTRAINT schedules_bill_check,
    DROP COLUMN bill_rule,
    DROP COLUMN card_statement_id;
ALTER TABLE bank_accounts
    DROP CONSTRAINT bank_accounts_card_pay_check,
    DROP COLUMN card_auto_finalize,
    DROP COLUMN card_pay_mode,
    DROP COLUMN card_pay_days_before,
    DROP COLUMN card_pay_amount,
    DROP COLUMN card_pay_rule;
DROP TYPE card_pay_rule;
