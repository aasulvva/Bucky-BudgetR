-- name: CreateCycle :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO cycles (id, user_id, start_at, end_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListCycles :many
SELECT * FROM cycles WHERE user_id = $1 ORDER BY start_at;

-- name: GetCycle :one
SELECT * FROM cycles WHERE id = $1 AND user_id = $2;

-- name: GetCycleForUpdate :one
SELECT * FROM cycles WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: GetActiveCycleForUpdate :one
SELECT * FROM cycles WHERE user_id = $1 AND state = 'active' FOR UPDATE;

-- name: NextFutureCycle :one
-- The earliest planned cycle, locked so it can be started or moved.
SELECT * FROM cycles WHERE user_id = $1 AND state = 'future' ORDER BY start_at LIMIT 1 FOR UPDATE;

-- name: SetCycleTimes :one
UPDATE cycles SET start_at = $2, end_at = $3, modified_at = now()
WHERE id = $1
RETURNING *;

-- name: SetCycleState :one
UPDATE cycles SET state = $2, modified_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteCycle :exec
DELETE FROM cycles WHERE id = $1 AND user_id = $2 AND state = 'future';

-- name: LastBucketLineAt :one
-- When the cycle's latest bucket line happened, or the epoch if it has none.
SELECT COALESCE(max(h.transaction_at), 'epoch')::timestamptz AS last_at
FROM bucket_transactions l
JOIN transaction_headers h ON h.id = l.transaction_id
WHERE l.cycle_id = $1;
