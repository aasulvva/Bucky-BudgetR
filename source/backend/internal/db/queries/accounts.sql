-- name: CreateAccount :one
-- Use with ids.Insert: a taken ID returns no row.
-- A new credit card's bill is set up as it's created (#262): card_bill_set_up_at.
INSERT INTO bank_accounts (id, user_id, name, currency, account_type, bank,
    card_default_account_id, card_credit_limit, card_statement_day, card_due_day, card_minimum_payment,
    card_bill_set_up_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, sqlc.narg(card_bill_set_up_at))
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
-- A type change to or from BSU clears its history setup (#214): a BSU is
-- locked until it's set up again. A credit card's fields are set on cards
-- only (#260), which never change type.
UPDATE bank_accounts SET name = $3, account_type = $4, expected_income = $5, bank = $6, modified_at = now(),
    card_default_account_id = $7, card_credit_limit = $8, card_statement_day = $9, card_due_day = $10,
    card_minimum_payment = $11,
    bsu_set_up_at = CASE WHEN account_type = $4 THEN bsu_set_up_at END,
    bsu_opened_year = CASE WHEN account_type = $4 THEN bsu_opened_year END
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

-- name: ClearCardDefaultAccount :exec
-- The cards whose default account this was have none (#260): the account is
-- deleted, or can't be a default account any more.
UPDATE bank_accounts SET card_default_account_id = NULL, modified_at = now()
WHERE user_id = $1 AND card_default_account_id = $2 AND NOT deleted;

-- name: ListCardIDs :many
-- The user's live credit cards (#260).
SELECT id FROM bank_accounts WHERE user_id = $1 AND NOT deleted AND account_type = 'credit_card';
