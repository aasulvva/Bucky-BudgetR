-- name: CreateAccount :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO bank_accounts (id, user_id, name, currency, account_type)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListAccounts :many
SELECT * FROM bank_accounts WHERE user_id = $1 AND NOT deleted ORDER BY lower(name), id;

-- name: GetAccount :one
SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2 AND NOT deleted;

-- name: GetAccountForUpdate :one
-- Locks the account until the transaction ends, so its balance can't change
-- meanwhile (the ledger locks accounts FOR SHARE when recording).
SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2 AND NOT deleted FOR UPDATE;

-- name: UpdateAccount :one
UPDATE bank_accounts SET name = $3, account_type = $4, modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted
RETURNING *;

-- name: DeleteAccount :exec
UPDATE bank_accounts SET deleted = true, modified_at = now() WHERE id = $1 AND user_id = $2;

-- name: ListSourceBuckets :many
-- The live buckets funded from an account, locked so they can be moved.
SELECT id FROM buckets WHERE source_account_id = $1 AND user_id = $2 AND NOT deleted ORDER BY id FOR UPDATE;

-- name: SetBucketSource :exec
-- CAF resets: the bucket is funded from the new account from now on.
UPDATE buckets SET source_account_id = $3, caf = 0, modified_at = now() WHERE id = $1 AND user_id = $2;
