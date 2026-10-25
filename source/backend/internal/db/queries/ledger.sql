-- name: CreateTransactionHeader :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO transaction_headers (
    id, user_id, parent_id, correction_type, transaction_type, transaction_at, counterparty, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: CreateBankLine :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO bank_transactions (
    id, transaction_id, account_id, amount, original_amount, original_currency, exchange_rate, created_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: CreateBucketLine :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO bucket_transactions (id, transaction_id, bucket_id, cycle_id, amount, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: UpsertTag :one
-- Returns the user's tag with this name (any case), creating it if needed.
INSERT INTO tags (user_id, name) VALUES ($1, $2)
ON CONFLICT (user_id, lower(name)) DO UPDATE SET name = tags.name
RETURNING id, name;

-- name: AddTransactionTag :exec
INSERT INTO transaction_tags (transaction_id, tag_id, user_id) VALUES ($1, $2, $3);

-- name: GetOwnedAccounts :many
-- FOR SHARE: waits for a concurrent delete or balance adjustment of the
-- account, then sees whether it still exists.
SELECT id, currency FROM bank_accounts
WHERE id = ANY(sqlc.arg(ids)::text[]) AND user_id = sqlc.arg(user_id) AND NOT deleted
FOR SHARE;

-- name: GetOwnedBuckets :many
SELECT id, source_account_id FROM buckets
WHERE id = ANY(sqlc.arg(ids)::text[]) AND user_id = sqlc.arg(user_id) AND NOT deleted;

-- name: GetActiveCycle :one
-- Locks the cycle until the transaction ends, so it can't be ended meanwhile.
SELECT * FROM cycles WHERE user_id = $1 AND state = 'active' FOR SHARE;

-- name: GetTransactionHeader :one
SELECT * FROM transaction_headers WHERE id = $1 AND user_id = $2;

-- name: ListBankLines :many
SELECT * FROM bank_transactions WHERE transaction_id = $1 ORDER BY id;

-- name: ListBucketLines :many
SELECT * FROM bucket_transactions WHERE transaction_id = $1 ORDER BY id;

-- name: ListTransactionTags :many
SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
WHERE tt.transaction_id = $1 ORDER BY lower(t.name) COLLATE "C";
