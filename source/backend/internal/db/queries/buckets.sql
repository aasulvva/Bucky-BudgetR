-- name: CreateBucket :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO buckets (
    id, user_id, name, source_account_id, refill_amount, cap_mode, cap_multiplier, cap_amount,
    keep_funds, refill_mode, overflow_destination, priority, importance, negative_tf,
    overflow_target_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListBuckets :many
SELECT sqlc.embed(b), a.currency,
    -- Whether the bucket has been refilled in the active cycle.
    EXISTS (
        SELECT 1 FROM refills r JOIN cycles c ON c.id = r.cycle_id
        WHERE r.bucket_id = b.id AND c.state = 'active'
    ) AS refilled
FROM buckets b
JOIN bank_accounts a ON a.id = b.source_account_id
WHERE b.user_id = $1 AND NOT b.deleted
ORDER BY lower(b.name), b.id;

-- name: GetBucket :one
SELECT sqlc.embed(b), a.currency,
    -- Whether the bucket has been refilled in the active cycle.
    EXISTS (
        SELECT 1 FROM refills r JOIN cycles c ON c.id = r.cycle_id
        WHERE r.bucket_id = b.id AND c.state = 'active'
    ) AS refilled
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
    priority = $13, importance = $14, negative_tf = $15, overflow_target_id = $16, modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted;

-- name: DeleteBucket :exec
-- A deleted bucket backs no money.
UPDATE buckets SET deleted = true, caf = 0, modified_at = now() WHERE id = $1 AND user_id = $2;

-- name: GetDefaultRefillMode :one
-- The user's preferred refill mode for new buckets, or '' if unset.
SELECT COALESCE(preferences ->> 'default_refill_mode', '')::text FROM users WHERE id = $1;

-- name: GetDefaultNegativeTF :one
-- What new buckets do with a negative TF, or '' if unset.
SELECT COALESCE(preferences ->> 'default_negative_tf', '')::text FROM users WHERE id = $1;

-- name: SavingsTargetForOverflow :one
-- A live savings target a bucket can send its overflow to: its currency, and
-- its bucket if it's a bucket target (a bucket can't overflow to itself).
SELECT h.id, h.bucket_id, COALESCE(a.currency, ba.currency)::text AS currency
FROM savings_holders h
LEFT JOIN bank_accounts a ON a.id = h.account_id
LEFT JOIN buckets b ON b.id = h.bucket_id
LEFT JOIN bank_accounts ba ON ba.id = b.source_account_id
WHERE h.id = $1 AND h.user_id = $2 AND h.kind = 'target' AND NOT h.deleted;
