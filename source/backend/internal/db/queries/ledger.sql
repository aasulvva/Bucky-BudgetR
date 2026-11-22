-- name: CreateTransactionHeader :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO transaction_headers (
    id, user_id, parent_id, correction_type, transaction_type, transaction_at, counterparty, created_by, replaces_id,
    triggers_refill, description
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
-- FOR SHARE: waits for a concurrent delete of the bucket, then sees whether it
-- still exists.
SELECT id, source_account_id FROM buckets
WHERE id = ANY(sqlc.arg(ids)::text[]) AND user_id = sqlc.arg(user_id) AND NOT deleted
FOR SHARE;

-- name: GetActiveCycle :one
-- Locks the cycle until the transaction ends, so it can't be ended meanwhile.
SELECT * FROM cycles WHERE user_id = $1 AND state = 'active' FOR SHARE;

-- name: GetTransactionHeader :one
SELECT * FROM transaction_headers WHERE id = $1 AND user_id = $2;

-- name: LockTransactionHeader :one
-- Locks an original transaction while it is corrected, so two corrections
-- can't work from the same state. A row lock doesn't fire the immutability
-- trigger.
SELECT * FROM transaction_headers WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: ListBankLines :many
SELECT * FROM bank_transactions WHERE transaction_id = $1 ORDER BY id;

-- name: ListBucketLines :many
SELECT * FROM bucket_transactions WHERE transaction_id = $1 ORDER BY id;

-- name: ListTransactionTags :many
SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
WHERE tt.transaction_id = $1 ORDER BY lower(t.name) COLLATE "C";

-- name: LockUser :exec
-- Serializes a user's money writes until the transaction ends (see
-- ledger.LockUser).
SELECT pg_advisory_xact_lock(1, (sqlc.arg(user_id)::text)::int);

-- name: CreateSavingsLine :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO savings_transactions (id, transaction_id, holder_id, account_id, cycle_id, amount, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListSavingsLines :many
SELECT * FROM savings_transactions WHERE transaction_id = $1 ORDER BY id;

-- name: GetOwnedSavingsHolders :many
-- FOR SHARE: waits for a concurrent delete of the holder, then sees whether it
-- still exists.
SELECT id FROM savings_holders
WHERE id = ANY(sqlc.arg(ids)::text[]) AND user_id = sqlc.arg(user_id) AND NOT deleted
FOR SHARE;

-- name: CycleAt :one
-- The user's cycle that contains the moment, whatever its state.
SELECT id FROM cycles
WHERE user_id = sqlc.arg(user_id) AND start_at <= sqlc.arg(at)::timestamptz AND sqlc.arg(at)::timestamptz < end_at;
