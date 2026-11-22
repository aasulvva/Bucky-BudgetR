-- Savings targets and the money held for them (#231, spec §8).

-- name: CreateSavingsHolder :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO savings_holders (id, user_id, kind, bucket_id, account_id, name, goal, note)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListSavingsTargets :many
-- The user's live targets, with what they are: the bucket's or account's name,
-- currency and type. Oldest first.
SELECT h.*,
    COALESCE(b.name, a.name)::text AS source_name,
    COALESCE(ba.currency, a.currency)::text AS currency,
    COALESCE(b.source_account_id, '')::text AS bucket_account_id
FROM savings_holders h
LEFT JOIN buckets b ON b.id = h.bucket_id
LEFT JOIN bank_accounts ba ON ba.id = b.source_account_id
LEFT JOIN bank_accounts a ON a.id = h.account_id
WHERE h.user_id = $1 AND h.kind = 'target' AND NOT h.deleted
ORDER BY h.created_at, h.id;

-- name: GetSavingsHolderForUpdate :one
-- Locks the holder until the transaction ends.
SELECT * FROM savings_holders WHERE id = $1 AND user_id = $2 AND NOT deleted FOR UPDATE;

-- name: GetTargetOfBucket :one
SELECT * FROM savings_holders WHERE bucket_id = $1 AND NOT deleted;

-- name: GetTargetOfAccount :one
SELECT * FROM savings_holders WHERE account_id = $1 AND NOT deleted;

-- name: UpdateSavingsTarget :one
UPDATE savings_holders SET name = $3, goal = $4, note = $5, modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted
RETURNING *;

-- name: DeleteSavingsHolder :exec
UPDATE savings_holders SET deleted = true, modified_at = now() WHERE id = $1 AND user_id = $2;

-- name: SavingsHeld :many
-- What each of the user's holders holds per source account (sums that aren't
-- 0), deleted holders left out.
SELECT l.holder_id, l.account_id, SUM(l.amount)::numeric AS held
FROM savings_transactions l
JOIN savings_holders h ON h.id = l.holder_id
WHERE h.user_id = $1 AND NOT h.deleted
GROUP BY l.holder_id, l.account_id
HAVING SUM(l.amount) <> 0
ORDER BY l.holder_id, l.account_id;

-- name: SavingsHeldOnAccount :many
-- What each holder holds on one source account (sums that aren't 0).
SELECT holder_id, SUM(amount)::numeric AS held
FROM savings_transactions
WHERE account_id = $1
GROUP BY holder_id
HAVING SUM(amount) <> 0
ORDER BY holder_id;

-- name: SavingsHeldAt :one
-- What a holder held on a source account at a moment: its lines dated up to
-- then (a correction counts at its original's time, as it's dated).
SELECT COALESCE(SUM(l.amount), 0)::numeric AS held
FROM savings_transactions l
JOIN transaction_headers t ON t.id = l.transaction_id
WHERE l.holder_id = $1 AND l.account_id = $2 AND t.transaction_at <= sqlc.arg(at)::timestamptz;

-- name: ReservedByAccount :many
-- Σ savings lines per source account: what's reserved for savings there.
SELECT l.account_id, SUM(l.amount)::numeric AS reserved
FROM savings_transactions l
JOIN savings_holders h ON h.id = l.holder_id
WHERE h.user_id = $1
GROUP BY l.account_id
HAVING SUM(l.amount) <> 0;

-- name: SavingsNewestLines :many
-- Each live holder's newest savings line: what a savings notification is
-- keyed by, so a dismissed one shows again once something changes.
SELECT DISTINCT ON (s.holder_id) s.holder_id, s.id
FROM savings_transactions s
JOIN savings_holders h ON h.id = s.holder_id
WHERE h.user_id = $1 AND NOT h.deleted
ORDER BY s.holder_id, s.created_at DESC, s.id DESC;
