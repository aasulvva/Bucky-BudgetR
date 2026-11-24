-- name: CardDebtHeld :many
-- What's held for each of the user's live credit cards per account (#261):
-- sums that aren't 0.
SELECT l.card_id, l.account_id, SUM(l.amount)::numeric AS held
FROM card_debt_lines l
JOIN bank_accounts c ON c.id = l.card_id
WHERE c.user_id = $1 AND NOT c.deleted
GROUP BY l.card_id, l.account_id
HAVING SUM(l.amount) <> 0
ORDER BY l.card_id, l.account_id;

-- name: CreateCardDebtLine :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO card_debt_lines (id, transaction_id, card_id, account_id, amount, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListCardDebtLines :many
SELECT * FROM card_debt_lines WHERE transaction_id = $1 ORDER BY id;

-- name: ListCardDebtLinesFor :many
SELECT * FROM card_debt_lines WHERE transaction_id = ANY(sqlc.arg(ids)::text[]) ORDER BY id;

-- A credit card's bill (#262, spec §2.2).

-- name: CardStatementsFor :many
-- The card's fixed statements, newest first.
SELECT * FROM card_statements WHERE card_id = $1 ORDER BY statement_date DESC LIMIT sqlc.arg(n);

-- name: CreateCardStatement :one
-- A statement already fixed for the day returns no row.
INSERT INTO card_statements (id, card_id, statement_date, cutoff, due_date, amount, minimum, paid_before,
    fixed_by, created_by, fixed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (card_id, statement_date) DO NOTHING
RETURNING *;

-- name: AccountBalanceBefore :one
-- One account's balance counting only transactions dated before the moment.
SELECT COALESCE(SUM(l.amount), 0)::numeric AS balance
FROM bank_transactions l
JOIN transaction_headers h ON h.id = l.transaction_id
WHERE l.account_id = sqlc.arg(account_id) AND h.transaction_at < sqlc.arg(before);

-- name: CardPaymentsBetween :one
-- What was paid into the card by transfers dated from the moment (and before
-- the end, when given): per transaction family, its net on the card when it
-- added to it. Cash advances (transfers out) and refunds don't count.
SELECT COALESCE(SUM(p.paid), 0)::numeric AS paid
FROM (
    SELECT SUM(l.amount) AS paid
    FROM bank_transactions l
    JOIN transaction_headers h ON h.id = l.transaction_id
    WHERE l.account_id = sqlc.arg(card_id) AND h.transaction_type = 'TRF'
      AND h.transaction_at >= sqlc.arg(from_at)
      AND (sqlc.narg(to_at)::timestamptz IS NULL OR h.transaction_at < sqlc.narg(to_at)::timestamptz)
    GROUP BY COALESCE(h.parent_id, h.id)
    HAVING SUM(l.amount) > 0
) p;

-- name: SetCardBillSetUp :one
-- Marks a card's bill set up (#262); no row when it already was.
UPDATE bank_accounts SET card_bill_set_up_at = sqlc.arg(at), modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted AND account_type = 'credit_card'
  AND card_bill_set_up_at IS NULL
RETURNING id;

-- name: CardsWithBills :many
-- Every user's live credit cards whose bill is set up, for fixing statements
-- whose due date has passed.
SELECT * FROM bank_accounts
WHERE account_type = 'credit_card' AND NOT deleted AND card_bill_set_up_at IS NOT NULL
ORDER BY user_id, id;

-- name: GetCardStatement :one
SELECT * FROM card_statements WHERE id = $1;
