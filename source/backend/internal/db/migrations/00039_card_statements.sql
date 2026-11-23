-- A credit card's bill (#262, spec §2.2). Each statement day the card owes
-- what it owed at the cutoff (the day's start in the user's time zone). The
-- current statement is worked out from the transactions, so ones entered
-- late but dated before the cutoff still count, until it's fixed: checked
-- against the bank's statement, or once its due date passes. Fixed
-- statements are stored here and don't change.
--
-- A card created before this has its bill locked until set up (its last
-- statement, or none): card_bill_set_up_at, like bsu_set_up_at (#214).

-- +goose Up
CREATE TYPE card_statement_fix AS ENUM ('bank', 'due', 'setup');

CREATE TABLE card_statements (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{11}$'), -- ids.CardStatement
    card_id        text NOT NULL REFERENCES bank_accounts (id),
    -- The statement day, and the moment it covers everything before.
    statement_date date NOT NULL,
    cutoff         timestamptz NOT NULL,
    due_date       date NOT NULL CHECK (due_date > statement_date),
    -- What the card owed at the cutoff (0 when in credit), and the minimum
    -- payment on it.
    amount         numeric(14, 2) NOT NULL CHECK (amount >= 0),
    minimum        numeric(14, 2) NOT NULL CHECK (minimum >= 0 AND minimum <= amount),
    -- Paid on it before the app knew (from the setup).
    paid_before    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (paid_before >= 0),
    fixed_by       card_statement_fix NOT NULL,
    fixed_at       timestamptz NOT NULL DEFAULT now(),
    created_by     text REFERENCES users (id),
    CHECK (left(id, 4) = card_id),
    CHECK (substr(id, 5) = to_char(statement_date, 'YYYYMMDD')),
    UNIQUE (card_id, statement_date)
);

CREATE TRIGGER card_statements_immutable BEFORE UPDATE OR DELETE ON card_statements
    FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER card_statements_no_truncate BEFORE TRUNCATE ON card_statements
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- Cards from before this are locked until their bill is set up.
ALTER TABLE bank_accounts ADD COLUMN card_bill_set_up_at timestamptz;

-- +goose Down
ALTER TABLE bank_accounts DROP COLUMN card_bill_set_up_at;
DROP TABLE card_statements;
DROP TYPE card_statement_fix;
