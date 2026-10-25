-- name: ListAllocationBuckets :many
-- The live buckets funded from these accounts, with what the allocation
-- routine needs.
SELECT id, source_account_id, caf, priority, importance FROM buckets
WHERE user_id = sqlc.arg(user_id) AND source_account_id = ANY(sqlc.arg(account_ids)::text[]) AND NOT deleted
ORDER BY id;

-- name: SetBucketCAF :exec
-- CAF is calculated, so it doesn't count as a change to the bucket
-- (modified_at stays).
UPDATE buckets SET caf = $2 WHERE id = $1;

-- name: BucketSourceAccounts :many
SELECT DISTINCT source_account_id FROM buckets WHERE id = ANY(sqlc.arg(ids)::text[]);

-- name: AllocatedByAccount :many
-- Σ CAF of the live buckets per source account.
SELECT source_account_id, COALESCE(SUM(caf), 0)::numeric AS allocated FROM buckets
WHERE user_id = $1 AND NOT deleted
GROUP BY source_account_id;
