-- Counting a purchase in its bucket later (#264, spec §5.5).

-- name: CreateWaitingLine :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO waiting_lines (id, transaction_id, purchase_id, bucket_id, amount, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListWaitingLines :many
SELECT * FROM waiting_lines WHERE transaction_id = $1 ORDER BY id;

-- name: ListWaitingLinesFor :many
SELECT * FROM waiting_lines WHERE transaction_id = ANY(sqlc.arg(ids)::text[]) ORDER BY id;

-- name: WaitingByAccount :many
-- What the user's live buckets owe their accounts for purchases that wait
-- for them (the advance), per source account: sums that aren't 0.
SELECT b.source_account_id, SUM(l.amount)::numeric AS waiting
FROM waiting_lines l
JOIN buckets b ON b.id = l.bucket_id
WHERE b.user_id = $1 AND NOT b.deleted
GROUP BY b.source_account_id
HAVING SUM(l.amount) <> 0;

-- name: BucketAccounts :many
-- The source account of each of these buckets.
SELECT id, source_account_id FROM buckets WHERE id = ANY(sqlc.arg(ids)::text[]);

-- name: CreateWaitingCharge :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO waiting_charges (id, user_id, transaction_id, bucket_id, "when", cycle_id, take_on)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: SetWaitingRule :exec
-- When a purchase's waiting charges are taken.
UPDATE waiting_charges SET "when" = $2, cycle_id = $3, take_on = $4, modified_at = now()
WHERE transaction_id = $1;

-- name: WaitingChargesFor :many
-- The waiting charges of these purchases, with each one's part (the
-- purchase's own waiting lines) and what's left (all its waiting lines:
-- the part less what's been taken).
SELECT c.*, k.deleted AS bucket_deleted, k.source_account_id,
    COALESCE((SELECT SUM(l.amount) FROM waiting_lines l
              JOIN transaction_headers h ON h.id = l.transaction_id
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id
                AND COALESCE(h.parent_id, h.id) = c.transaction_id), 0)::numeric AS part,
    COALESCE((SELECT SUM(l.amount) FROM waiting_lines l
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id), 0)::numeric AS left_amount
FROM waiting_charges c
JOIN buckets k ON k.id = c.bucket_id
WHERE c.transaction_id = ANY(sqlc.arg(ids)::text[])
ORDER BY c.transaction_id, c.bucket_id;

-- name: GetWaitingCharge :one
-- A waiting charge of the user's, with what's left.
SELECT c.*, k.deleted AS bucket_deleted,
    COALESCE((SELECT SUM(l.amount) FROM waiting_lines l
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id), 0)::numeric AS left_amount
FROM waiting_charges c
JOIN buckets k ON k.id = c.bucket_id
WHERE c.id = $1 AND c.user_id = $2;

-- name: ListOpenWaitingCharges :many
-- The user's waiting charges with something left on live buckets, oldest
-- purchase first, with the account the purchase is on; optionally only those
-- of buckets on one account.
SELECT c.id, c.transaction_id, c.bucket_id, c."when", c.cycle_id, c.take_on, k.source_account_id,
    b.account_id AS purchase_account_id, h.transaction_at, h.counterparty, w.left_amount::numeric AS left_amount
FROM waiting_charges c
JOIN buckets k ON k.id = c.bucket_id
JOIN transaction_headers h ON h.id = c.transaction_id
JOIN bank_transactions b ON b.transaction_id = c.transaction_id
JOIN LATERAL (SELECT COALESCE(SUM(l.amount), 0) AS left_amount FROM waiting_lines l
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id) w ON true
WHERE c.user_id = sqlc.arg(user_id) AND NOT k.deleted AND w.left_amount > 0
  AND (sqlc.narg(account_id)::text IS NULL OR k.source_account_id = sqlc.narg(account_id)::text)
ORDER BY h.transaction_at, c.transaction_id, c.bucket_id;

-- name: DueWaitingCharges :many
-- The cycle and month charges due at the start of a cycle starting on
-- start_date, with something left on live buckets: a charge for this cycle,
-- or for a deleted cycle or a month from on or before its start.
SELECT c.id, c.transaction_id, c.bucket_id, w.left_amount::numeric AS left_amount
FROM waiting_charges c
JOIN buckets k ON k.id = c.bucket_id
JOIN LATERAL (SELECT COALESCE(SUM(l.amount), 0) AS left_amount FROM waiting_lines l
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id) w ON true
WHERE c.user_id = sqlc.arg(user_id) AND NOT k.deleted AND w.left_amount > 0
  AND (c.cycle_id = sqlc.arg(cycle_id)::text
       OR (c."when" = 'cycle' AND c.cycle_id IS NULL AND c.take_on <= sqlc.arg(start_date)::date)
       OR (c."when" = 'month' AND c.take_on <= sqlc.arg(start_date)::date))
ORDER BY c.transaction_id, c.bucket_id;

-- name: PaidWaitingCharges :many
-- The charges taken as card purchases are paid off, on these cards (all of
-- the user's when null), that have a part or a take: with the card, the
-- part and what's left.
SELECT c.id, c.transaction_id, c.bucket_id, k.deleted AS bucket_deleted, b.account_id AS card_id,
    p.part::numeric AS part, w.left_amount::numeric AS left_amount
FROM waiting_charges c
JOIN buckets k ON k.id = c.bucket_id
JOIN bank_transactions b ON b.transaction_id = c.transaction_id
JOIN LATERAL (SELECT COALESCE(SUM(l.amount), 0) AS left_amount FROM waiting_lines l
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id) w ON true
JOIN LATERAL (SELECT COALESCE(SUM(l.amount), 0) AS part FROM waiting_lines l
              JOIN transaction_headers h ON h.id = l.transaction_id
              WHERE l.purchase_id = c.transaction_id AND l.bucket_id = c.bucket_id
                AND COALESCE(h.parent_id, h.id) = c.transaction_id) p ON true
WHERE c.user_id = sqlc.arg(user_id) AND c."when" = 'paid'
  AND (sqlc.narg(card_ids)::text[] IS NULL OR b.account_id = ANY(sqlc.narg(card_ids)::text[]))
  AND (p.part <> 0 OR w.left_amount <> p.part)
ORDER BY b.account_id, c.transaction_id, c.bucket_id;

-- name: CardFamilyNets :many
-- Each transaction family on a card, oldest first, with its net amount
-- there (with its corrections): debt below 0, payments and refunds above.
SELECT h.id, h.transaction_at, SUM(b.amount)::numeric AS net
FROM transaction_headers h
JOIN transaction_headers c ON c.id = h.id OR c.parent_id = h.id
JOIN bank_transactions b ON b.transaction_id = c.id
WHERE b.account_id = $1 AND h.correction_type = 'none'
GROUP BY h.id, h.transaction_at
ORDER BY h.transaction_at, h.id;

-- name: WaitingTakes :many
-- The DBCs that took from a purchase's waiting charge and aren't reversed,
-- newest first, with what each took (a positive amount).
SELECT h.id, h.transaction_at, h.counterparty, h.description, (-SUM(l.amount))::numeric AS taken
FROM transaction_headers h
JOIN transaction_headers c ON c.id = h.id OR c.parent_id = h.id
JOIN waiting_lines l ON l.transaction_id = c.id
WHERE h.transaction_type = 'DBC' AND h.correction_type = 'none'
  AND l.purchase_id = $1 AND l.bucket_id = $2
GROUP BY h.id, h.transaction_at, h.counterparty, h.description
HAVING SUM(l.amount) <> 0
ORDER BY h.transaction_at DESC, h.id DESC;

-- name: AutoTakesIn :many
-- The DBCs the cycle start made in a cycle (created by the system) that
-- aren't reversed (#264), for the notification: with the bucket, what it
-- took and its counterparty, the purchase's when it took it.
SELECT h.id, h.transaction_at, l.bucket_id, l.purchase_id, h.counterparty, a.currency,
    (-SUM(l.amount))::numeric AS taken
FROM transaction_headers h
JOIN transaction_headers c ON c.id = h.id OR c.parent_id = h.id
JOIN waiting_lines l ON l.transaction_id = c.id
JOIN buckets k ON k.id = l.bucket_id
JOIN bank_accounts a ON a.id = k.source_account_id
WHERE h.user_id = $1 AND h.transaction_type = 'DBC' AND h.correction_type = 'none' AND h.created_by IS NULL
  AND h.transaction_at >= sqlc.arg(from_at) AND h.transaction_at < sqlc.arg(to_at)
GROUP BY h.id, h.transaction_at, l.bucket_id, l.purchase_id, h.counterparty, a.currency
HAVING SUM(l.amount) <> 0
ORDER BY h.transaction_at, h.id;

-- name: NewestInFamily :one
-- The newest header of a transaction's family: its effective counterparty,
-- description and tags.
SELECT * FROM transaction_headers
WHERE (id = sqlc.arg(id) OR parent_id = sqlc.arg(id)) AND user_id = sqlc.arg(user_id)
ORDER BY created_at DESC, id DESC
LIMIT 1;
