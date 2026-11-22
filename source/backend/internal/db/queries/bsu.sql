-- BSU accounts (#214): the deposit rules, and what the accounts' transactions
-- add up to.

-- name: ListBSURules :many
SELECT * FROM bsu_rules ORDER BY from_year;

-- name: UpsertBSURule :one
INSERT INTO bsu_rules (from_year, yearly_limit, total_limit, updated_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (from_year) DO UPDATE
SET yearly_limit = EXCLUDED.yearly_limit, total_limit = EXCLUDED.total_limit,
    updated_by = EXCLUDED.updated_by, modified_at = now()
RETURNING *;

-- name: DeleteBSURule :execrows
DELETE FROM bsu_rules WHERE from_year = $1;

-- name: CountBSURules :one
SELECT count(*) FROM bsu_rules;

-- name: BSUFamilyNets :many
-- Each INC, TRF and EXP family's net on these accounts, on the original's
-- date, as the stats count it: a reversed one adds up to 0 and is left out.
-- interest is whether the family's newest header (its effective values) is
-- tagged interest (#70).
WITH families AS (
    SELECT h.id, h.transaction_type, h.transaction_at, EXISTS (
        SELECT 1 FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
        WHERE tt.transaction_id = latest.id AND lower(t.name) = 'interest'
    ) AS interest
    FROM transaction_headers h
    JOIN LATERAL (
        SELECT c.id FROM transaction_headers c
        WHERE c.id = h.id OR c.parent_id = h.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
    ) latest ON true
    WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none'
      AND h.transaction_type IN ('INC', 'TRF', 'EXP')
      AND EXISTS (
          SELECT 1 FROM bank_transactions b JOIN transaction_headers c ON c.id = b.transaction_id
          WHERE b.account_id = ANY(sqlc.arg(account_ids)::text[]) AND (c.id = h.id OR c.parent_id = h.id))
)
SELECT f.id, f.transaction_type, f.transaction_at, f.interest, b.account_id, SUM(b.amount)::numeric AS net
FROM families f
JOIN transaction_headers c ON c.id = f.id OR c.parent_id = f.id
JOIN bank_transactions b ON b.transaction_id = c.id
WHERE b.account_id = ANY(sqlc.arg(account_ids)::text[])
GROUP BY f.id, f.transaction_type, f.transaction_at, f.interest, b.account_id
HAVING SUM(b.amount) <> 0
ORDER BY f.transaction_at, f.id;

-- name: ListOpeningBalances :many
-- The opening balances (OPB families) on the account, with their net on it,
-- for the history setup to bring to 0.
SELECT h.id, h.transaction_at, SUM(b.amount)::numeric AS net
FROM transaction_headers h
JOIN transaction_headers c ON c.id = h.id OR c.parent_id = h.id
JOIN bank_transactions b ON b.transaction_id = c.id AND b.account_id = sqlc.arg(account_id)
WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none' AND h.transaction_type = 'OPB'
GROUP BY h.id, h.transaction_at
HAVING SUM(b.amount) <> 0
ORDER BY h.transaction_at, h.id;

-- name: SetBSUSetUp :exec
UPDATE bank_accounts SET bsu_set_up_at = sqlc.arg(at), bsu_opened_year = sqlc.arg(opened_year), modified_at = now()
WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id) AND NOT deleted;

-- name: ListScheduledWithdrawals :many
-- The BSU withdrawals (EXP, or TRF out) a schedule recorded in [from, to),
-- with their net on the account, for the bsu_withdrawal notification.
SELECT h.id, h.transaction_at, b.account_id, SUM(b.amount)::numeric AS net
FROM schedule_occurrences o
JOIN transaction_headers h ON h.id = o.transaction_id AND h.correction_type = 'none'
JOIN transaction_headers c ON c.id = h.id OR c.parent_id = h.id
JOIN bank_transactions b ON b.transaction_id = c.id
JOIN bank_accounts a ON a.id = b.account_id AND a.account_type = 'bsu' AND NOT a.deleted
WHERE o.user_id = sqlc.arg(user_id) AND h.transaction_type IN ('EXP', 'TRF')
  AND h.transaction_at >= sqlc.arg(from_at) AND h.transaction_at < sqlc.arg(to_at)
GROUP BY h.id, h.transaction_at, b.account_id
HAVING SUM(b.amount) < 0
ORDER BY h.transaction_at, h.id;
