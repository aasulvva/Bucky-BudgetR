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

-- The savings distributor (#232).

-- name: GetDistributor :one
SELECT * FROM savings_holders WHERE user_id = $1 AND kind = 'distributor';

-- name: GetDistributorForUpdate :one
-- Locks the distributor until the transaction ends.
SELECT * FROM savings_holders WHERE user_id = $1 AND kind = 'distributor' FOR UPDATE;

-- name: CreateDistributor :one
-- Use with ids.Insert: a taken ID (or a distributor the user has already)
-- returns no row.
INSERT INTO savings_holders (id, user_id, kind, hold_mode, min_amount)
VALUES ($1, $2, 'distributor', $3, $4)
ON CONFLICT DO NOTHING
RETURNING *;

-- name: UpdateDistributor :one
UPDATE savings_holders SET hold_mode = $2, min_amount = $3, modified_at = now()
WHERE user_id = $1 AND kind = 'distributor'
RETURNING *;

-- name: ListSavingsRules :many
-- The user's rules on live targets, by target, then range.
SELECT r.* FROM savings_rules r
JOIN savings_holders h ON h.id = r.target_id
WHERE r.user_id = $1 AND NOT h.deleted
ORDER BY h.created_at, h.id, r.range_from, r.id;

-- name: GetSavingsRule :one
SELECT * FROM savings_rules WHERE id = $1 AND user_id = $2;

-- name: CreateSavingsRule :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO savings_rules (id, target_id, user_id, range_from, range_to, priority, past_goal)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: UpdateSavingsRule :one
UPDATE savings_rules SET range_from = $3, range_to = $4, priority = $5, past_goal = $6, modified_at = now()
WHERE id = $1 AND user_id = $2
RETURNING *;

-- name: DeleteSavingsRule :execrows
DELETE FROM savings_rules WHERE id = $1 AND user_id = $2;

-- name: DeleteRulesOfTarget :exec
DELETE FROM savings_rules WHERE target_id = $1;

-- name: RedirectOverflowToDistributor :many
-- The buckets that sent their overflow to a target that goes away send it to
-- the distributor instead (#233).
UPDATE buckets SET overflow_destination = 'savings_distribution', overflow_target_id = NULL, modified_at = now()
WHERE user_id = $1 AND overflow_target_id = $2
RETURNING id;
