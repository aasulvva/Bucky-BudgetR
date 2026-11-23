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
