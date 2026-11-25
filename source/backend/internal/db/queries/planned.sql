-- name: CreatePlannedPurchase :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO planned_purchases (id, user_id, name, account_id, amount, expected_at, note)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: UpdatePlannedPurchase :one
UPDATE planned_purchases SET
    name = $3, account_id = $4, amount = $5, expected_at = $6, note = $7, updated_at = now()
WHERE id = $1 AND user_id = $2
RETURNING *;

-- name: GetPlannedPurchase :one
SELECT * FROM planned_purchases WHERE id = $1 AND user_id = $2;

-- name: GetPlannedPurchaseForUpdate :one
SELECT * FROM planned_purchases WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: ListPlannedPurchases :many
-- The user's planned purchases of these statuses, the soonest expected
-- first.
SELECT * FROM planned_purchases
WHERE user_id = $1 AND status::text = ANY(sqlc.arg(statuses)::text[])
ORDER BY expected_at, created_at, id;

-- name: CancelPlannedPurchase :exec
UPDATE planned_purchases SET status = 'cancelled', updated_at = now()
WHERE id = $1 AND user_id = $2;

-- name: ChargePlannedPurchase :exec
-- Closes it with the expense that recorded its charge.
UPDATE planned_purchases SET status = 'charged', transaction_id = $3, updated_at = now()
WHERE id = $1 AND user_id = $2;

-- name: AddPlannedBucketLine :exec
INSERT INTO planned_purchase_bucket_lines (planned_id, bucket_id, user_id, amount, position)
VALUES ($1, $2, $3, $4, $5);

-- name: DeletePlannedBucketLines :exec
DELETE FROM planned_purchase_bucket_lines WHERE planned_id = $1 AND user_id = $2;

-- name: ListPlannedBucketLines :many
-- The bucket parts of these planned purchases, in the order they were given.
SELECT * FROM planned_purchase_bucket_lines WHERE planned_id = ANY(sqlc.arg(ids)::text[])
ORDER BY planned_id, position;

