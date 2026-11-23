-- Card debt held per account (#261, spec §2.2). Money that pays a credit
-- card's debt stays in the account that budgeted it until the bill is paid,
-- held there for the card: card debt lines record it, beside bank, bucket and
-- savings lines. What's held on an account for a card is the sum of its lines
-- there; it's covered before the account's buckets.
--
-- A purchase on a card holds its bucket parts on the buckets' accounts and the
-- rest on the account the user chose; a payment releases them, a transfer can
-- carry them along, and CDH and CDR hold or release debt on their own.

-- +goose Up
CREATE TABLE card_debt_lines (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{23}$'), -- ids.CardDebtLine
    transaction_id text NOT NULL REFERENCES transaction_headers (id),
    -- The credit card the debt is on.
    card_id        text NOT NULL REFERENCES bank_accounts (id),
    -- The account the money is held on.
    account_id     text NOT NULL REFERENCES bank_accounts (id),
    amount         numeric(14, 2) NOT NULL CHECK (amount <> 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     text REFERENCES users (id),
    CHECK (left(id, 4) = card_id),
    CHECK (account_id <> card_id)
);

CREATE INDEX card_debt_lines_transaction_id_idx ON card_debt_lines (transaction_id);
-- Covering, so what's held per card and account is a cheap sum.
CREATE INDEX card_debt_lines_card_id_idx ON card_debt_lines (card_id, account_id) INCLUDE (amount);
CREATE INDEX card_debt_lines_account_id_idx ON card_debt_lines (account_id) INCLUDE (amount);

CREATE TRIGGER card_debt_lines_immutable BEFORE UPDATE OR DELETE ON card_debt_lines
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER card_debt_lines_no_truncate BEFORE TRUNCATE ON card_debt_lines
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- +goose Down
-- The CDH and CDR transactions go too (with the ledger's delete switch, see
-- 00023); their types stay in the enum (00037). Purchases, payments and
-- transfers stay, without their card debt lines.
SELECT set_config('bucky.replacing_user_data', 'on', true);
DROP TABLE card_debt_lines;
DELETE FROM transaction_tags tt USING transaction_headers h
WHERE h.id = tt.transaction_id AND h.transaction_type IN ('CDH', 'CDR');
DELETE FROM transaction_headers WHERE transaction_type IN ('CDH', 'CDR') AND parent_id IS NOT NULL;
DELETE FROM transaction_headers WHERE transaction_type IN ('CDH', 'CDR');
SELECT set_config('bucky.replacing_user_data', 'off', true);
