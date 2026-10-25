-- name: CreateBucket :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO buckets (
    id, user_id, name, source_account_id, refill_amount, cap_mode, cap_multiplier, cap_amount,
    keep_funds, refill_mode, overflow_destination, priority, importance
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListBuckets :many
SELECT sqlc.embed(b), a.currency
FROM buckets b
JOIN bank_accounts a ON a.id = b.source_account_id
WHERE b.user_id = $1 AND NOT b.deleted
ORDER BY lower(b.name), b.id;

-- name: GetBucket :one
SELECT sqlc.embed(b), a.currency
FROM buckets b
JOIN bank_accounts a ON a.id = b.source_account_id
WHERE b.id = $1 AND b.user_id = $2 AND NOT b.deleted;

-- name: GetBucketForUpdate :one
-- Locks the bucket until the transaction ends.
SELECT * FROM buckets WHERE id = $1 AND user_id = $2 AND NOT deleted FOR UPDATE;

-- name: UpdateBucket :exec
UPDATE buckets SET
    name = $3, source_account_id = $4, refill_amount = $5, cap_mode = $6, cap_multiplier = $7,
    cap_amount = $8, caf = $9, keep_funds = $10, refill_mode = $11, overflow_destination = $12,
    priority = $13, importance = $14, modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted;

-- name: DeleteBucket :exec
-- A deleted bucket backs no money.
UPDATE buckets SET deleted = true, caf = 0, modified_at = now() WHERE id = $1 AND user_id = $2;

-- name: GetDefaultRefillMode :one
-- The user's preferred refill mode for new buckets, or '' if unset.
SELECT COALESCE(preferences ->> 'default_refill_mode', '')::text FROM users WHERE id = $1;
