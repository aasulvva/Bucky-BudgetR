-- name: ListTransactions :many
-- A page of the user's original transactions (not corrections), newest first.
-- A null filter matches everything. The account and bucket filters also match
-- lines added by corrections; the tag and counterparty filters use the
-- newest header of the family, which holds the effective values. The
-- counterparty filter matches the description too (#130).
-- before_at/before_id is the keyset cursor: the last row of the previous page.
SELECT h.* FROM transaction_headers h
JOIN LATERAL (
    SELECT c.id, c.counterparty, c.description FROM transaction_headers c
    WHERE c.id = h.id OR c.parent_id = h.id
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT 1
) latest ON true
WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none'
  AND (sqlc.narg(types)::text[] IS NULL OR h.transaction_type::text = ANY(sqlc.narg(types)::text[]))
  AND (sqlc.narg(from_at)::timestamptz IS NULL OR h.transaction_at >= sqlc.narg(from_at)::timestamptz)
  AND (sqlc.narg(to_at)::timestamptz IS NULL OR h.transaction_at < sqlc.narg(to_at)::timestamptz)
  AND (sqlc.narg(account_id)::text IS NULL OR EXISTS (
      SELECT 1 FROM bank_transactions b JOIN transaction_headers c ON c.id = b.transaction_id
      WHERE b.account_id = sqlc.narg(account_id)::text AND (c.id = h.id OR c.parent_id = h.id)))
  AND (sqlc.narg(bucket_id)::text IS NULL OR EXISTS (
      SELECT 1 FROM bucket_transactions b JOIN transaction_headers c ON c.id = b.transaction_id
      WHERE b.bucket_id = sqlc.narg(bucket_id)::text AND (c.id = h.id OR c.parent_id = h.id)))
  AND (sqlc.narg(tag)::text IS NULL OR EXISTS (
      SELECT 1 FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
      WHERE tt.transaction_id = latest.id AND lower(t.name) = lower(sqlc.narg(tag)::text)))
  -- counterparty is a LIKE pattern, escaped by the caller, matching the
  -- counterparty or the description (#130).
  AND (sqlc.narg(counterparty)::text IS NULL OR latest.counterparty ILIKE sqlc.narg(counterparty)::text
           OR latest.description ILIKE sqlc.narg(counterparty)::text)
  -- counterparty_is matches the whole counterparty, ignoring case and spaces at the ends (#170).
  AND (sqlc.narg(counterparty_is)::text IS NULL
       OR lower(btrim(latest.counterparty)) = lower(btrim(sqlc.narg(counterparty_is)::text)))
  -- reversed: only reversed ones (moved originals too), or only the others.
  AND (sqlc.narg(reversed)::boolean IS NULL OR EXISTS (
      SELECT 1 FROM transaction_headers r WHERE r.parent_id = h.id AND r.correction_type = 'reversal'
  ) = sqlc.narg(reversed)::boolean)
  AND (sqlc.narg(before_at)::timestamptz IS NULL
       OR (h.transaction_at, h.id) < (sqlc.narg(before_at)::timestamptz, sqlc.narg(before_id)::text))
ORDER BY h.transaction_at DESC, h.id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListTransactionFamilies :many
-- The original transactions with these IDs and all their corrections, each
-- family's original first, then its corrections in the order they were made.
SELECT * FROM transaction_headers
WHERE user_id = sqlc.arg(user_id)
  AND (id = ANY(sqlc.arg(ids)::text[]) OR parent_id = ANY(sqlc.arg(ids)::text[]))
ORDER BY correction_type <> 'none', created_at, id;

-- name: ListBankLinesFor :many
SELECT * FROM bank_transactions WHERE transaction_id = ANY(sqlc.arg(ids)::text[]) ORDER BY id;

-- name: ListBucketLinesFor :many
SELECT * FROM bucket_transactions WHERE transaction_id = ANY(sqlc.arg(ids)::text[]) ORDER BY id;

-- name: ListTagsFor :many
SELECT tt.transaction_id, t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
WHERE tt.transaction_id = ANY(sqlc.arg(ids)::text[])
ORDER BY lower(t.name) COLLATE "C";

-- name: ListReplacedBy :many
-- The transactions that replace any of these (after a move to another account).
SELECT id, replaces_id::text AS replaces_id FROM transaction_headers
WHERE replaces_id = ANY(sqlc.arg(ids)::text[]);

-- name: ListSchedulesFor :many
-- The schedules that recorded any of these transactions.
SELECT transaction_id::text AS transaction_id, schedule_id FROM schedule_occurrences
WHERE transaction_id = ANY(sqlc.arg(ids)::text[]);

-- name: ListTagSuggestions :many
-- The user's tags for autocompletion, most recently used first (by
-- transaction time, on any header), then unused ones by name. q is a LIKE
-- pattern, escaped by the caller.
-- last_used_at is only meaningful when used is set (timestamptz maps to a
-- plain time.Time).
SELECT t.name, (used.transaction_at IS NOT NULL)::bool AS used,
       coalesce(used.transaction_at, t.created_at)::timestamptz AS last_used_at
FROM tags t
LEFT JOIN LATERAL (
    SELECT h.transaction_at FROM transaction_tags tt
    JOIN transaction_headers h ON h.id = tt.transaction_id
    WHERE tt.tag_id = t.id
    ORDER BY h.transaction_at DESC
    LIMIT 1
) used ON true
WHERE t.user_id = sqlc.arg(user_id)
  AND (sqlc.narg(q)::text IS NULL OR t.name ILIKE sqlc.narg(q)::text)
ORDER BY used.transaction_at DESC NULLS LAST, lower(t.name) COLLATE "C"
LIMIT sqlc.arg(row_limit);

-- name: ListCounterpartyOriginals :many
-- For autocompletion: per counterparty (ignoring case), the newest original
-- income or expense that isn't reversed, newest first. The counterparty is
-- the family's effective one, from its newest header. q is a LIKE pattern,
-- escaped by the caller.
SELECT id FROM (
    SELECT DISTINCT ON (lower(latest.counterparty)) h.id, h.transaction_at
    FROM transaction_headers h
    JOIN LATERAL (
        SELECT c.counterparty FROM transaction_headers c
        WHERE c.id = h.id OR c.parent_id = h.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
    ) latest ON true
    WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none'
      AND h.transaction_type::text = ANY(sqlc.arg(types)::text[])
      AND latest.counterparty <> ''
      AND (sqlc.narg(q)::text IS NULL OR latest.counterparty ILIKE sqlc.narg(q)::text)
      AND NOT EXISTS (
          SELECT 1 FROM transaction_headers r
          WHERE r.parent_id = h.id AND r.correction_type = 'reversal')
    ORDER BY lower(latest.counterparty), h.transaction_at DESC, h.id DESC
) newest
ORDER BY transaction_at DESC, id DESC
LIMIT sqlc.arg(row_limit);

-- name: BalancesAfter :many
-- Each account's balance just after each of the given original transactions
-- (#106): the account's balance now, less what came after the transaction in
-- the list's order (transaction_at, id). A transaction counts with its
-- corrections, which are dated at its time: the balance as it is now
-- understood. Only lines from since (the oldest of the transactions) on are
-- sorted, so recent pages stay cheap however long the ledger is.
-- Transactions that come to 0 in an account (reversed, or moved away) get no
-- row for it.
WITH total AS (
    SELECT account_id, SUM(amount) AS balance FROM bank_transactions
    WHERE account_id = ANY(sqlc.arg(account_ids)::text[])
    GROUP BY account_id
), later AS (
    SELECT b.account_id, COALESCE(c.parent_id, c.id) AS root, c.transaction_at AS at, SUM(b.amount) AS amount
    FROM transaction_headers c
    JOIN bank_transactions b ON b.transaction_id = c.id
    WHERE c.user_id = sqlc.arg(user_id) AND c.transaction_at >= sqlc.arg(since)::timestamptz
      AND b.account_id = ANY(sqlc.arg(account_ids)::text[])
    GROUP BY b.account_id, COALESCE(c.parent_id, c.id), c.transaction_at
), run AS (
    SELECT l.account_id, l.root, l.amount,
           t.balance - COALESCE(SUM(l.amount) OVER (
               PARTITION BY l.account_id ORDER BY l.at DESC, l.root DESC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS balance
    FROM later l JOIN total t ON t.account_id = l.account_id
)
SELECT account_id, root::text AS transaction_id, balance::numeric AS balance FROM run
WHERE root = ANY(sqlc.arg(ids)::text[]) AND amount <> 0
ORDER BY account_id, transaction_id;
