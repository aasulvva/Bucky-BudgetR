-- name: ListTransactions :many
-- A page of the user's original transactions (not corrections), newest first.
-- A null filter matches everything. The account and bucket filters also match
-- lines added by corrections; the tag and counterparty filters use the
-- newest header of the family, which holds the effective values.
-- before_at/before_id is the keyset cursor: the last row of the previous page.
SELECT h.* FROM transaction_headers h
JOIN LATERAL (
    SELECT c.id, c.counterparty FROM transaction_headers c
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
  -- counterparty is a LIKE pattern, escaped by the caller.
  AND (sqlc.narg(counterparty)::text IS NULL OR latest.counterparty ILIKE sqlc.narg(counterparty)::text)
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
