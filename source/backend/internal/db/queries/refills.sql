-- Refills (spec §6). Callers hold the user's lock (ledger.LockUser), so
-- checking whether a bucket was refilled and recording the refill can't race.

-- name: ListRefillBuckets :many
-- The user's live buckets with this refill mode that haven't been refilled in
-- the cycle, optionally only those funded from one account.
SELECT * FROM buckets b
WHERE b.user_id = sqlc.arg(user_id) AND NOT b.deleted AND b.refill_mode = sqlc.arg(mode)
    AND (sqlc.narg(account_id)::text IS NULL OR b.source_account_id = sqlc.narg(account_id))
    AND NOT EXISTS (SELECT 1 FROM refills r WHERE r.bucket_id = b.id AND r.cycle_id = sqlc.arg(cycle_id))
ORDER BY b.id;

-- name: IsRefilled :one
SELECT EXISTS (SELECT 1 FROM refills WHERE bucket_id = $1 AND cycle_id = $2);

-- name: CreateRefill :exec
INSERT INTO refills (bucket_id, cycle_id, user_id, trigger, ref_id, ovf_id, income_id)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListRefillsByIncome :many
-- The refills an income triggered in a cycle.
SELECT * FROM refills WHERE income_id = $1 AND cycle_id = $2 ORDER BY bucket_id;

-- name: DeleteRefill :exec
DELETE FROM refills WHERE bucket_id = $1 AND cycle_id = $2;

-- name: ListOverflowBuckets :many
-- The user's live buckets without Keep funds, which are emptied at cycle end.
SELECT * FROM buckets WHERE user_id = $1 AND NOT deleted AND NOT keep_funds ORDER BY id;

-- name: IncomeRefillRules :one
-- The user's income_refill_rules preference, or an empty array.
SELECT COALESCE(preferences -> 'income_refill_rules', '[]')::jsonb FROM users WHERE id = $1;
