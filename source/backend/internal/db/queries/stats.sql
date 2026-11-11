-- The Stats API's sums (#121). A transaction family (an original and its
-- corrections) counts on the original's date, as the transaction list and
-- AccountFlows count it, so a reversed one adds up to 0. The filters work as
-- on the transaction list: tags, counterparty and description from the
-- family's newest header. A null filter matches everything. The queries return each
-- family's net per account or bucket; Go puts them into intervals.

-- name: StatsBankNets :many
-- Each family's net per bank account, with its effective counterparty, for
-- families of the given types in [from_at, to_at).
WITH families AS (
    SELECT h.id, h.transaction_type, h.transaction_at, latest.counterparty
    FROM transaction_headers h
    JOIN LATERAL (
        SELECT c.id, c.counterparty, c.description FROM transaction_headers c
        WHERE c.id = h.id OR c.parent_id = h.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
    ) latest ON true
    WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none'
      AND h.transaction_type::text = ANY(sqlc.arg(types)::text[])
      AND h.transaction_at >= sqlc.arg(from_at) AND h.transaction_at < sqlc.arg(to_at)
      AND (sqlc.narg(tags)::text[] IS NULL OR EXISTS (
          SELECT 1 FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
          WHERE tt.transaction_id = latest.id AND lower(t.name) = ANY(sqlc.narg(tags)::text[])))
      -- counterparty is a LIKE pattern, escaped by the caller, matching the
  -- counterparty or the description (#130).
      AND (sqlc.narg(counterparty)::text IS NULL OR latest.counterparty ILIKE sqlc.narg(counterparty)::text
           OR latest.description ILIKE sqlc.narg(counterparty)::text)
)
SELECT f.id, f.transaction_type, f.transaction_at, f.counterparty, b.account_id, a.currency, SUM(b.amount)::numeric AS net
FROM families f
JOIN transaction_headers c ON c.id = f.id OR c.parent_id = f.id
JOIN bank_transactions b ON b.transaction_id = c.id
JOIN bank_accounts a ON a.id = b.account_id
WHERE sqlc.narg(account_ids)::text[] IS NULL OR b.account_id = ANY(sqlc.narg(account_ids)::text[])
GROUP BY f.id, f.transaction_type, f.transaction_at, f.counterparty, b.account_id, a.currency
HAVING SUM(b.amount) <> 0
ORDER BY f.transaction_at, f.id, b.account_id;

-- name: StatsBucketNets :many
-- Each family's net per bucket, with the bucket's source account, for
-- families of the given types in [from_at, to_at). The account filter
-- matches the bucket's source account.
WITH families AS (
    SELECT h.id, h.transaction_type, h.transaction_at, latest.counterparty
    FROM transaction_headers h
    JOIN LATERAL (
        SELECT c.id, c.counterparty, c.description FROM transaction_headers c
        WHERE c.id = h.id OR c.parent_id = h.id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
    ) latest ON true
    WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none'
      AND h.transaction_type::text = ANY(sqlc.arg(types)::text[])
      AND h.transaction_at >= sqlc.arg(from_at) AND h.transaction_at < sqlc.arg(to_at)
      AND (sqlc.narg(tags)::text[] IS NULL OR EXISTS (
          SELECT 1 FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
          WHERE tt.transaction_id = latest.id AND lower(t.name) = ANY(sqlc.narg(tags)::text[])))
      AND (sqlc.narg(counterparty)::text IS NULL OR latest.counterparty ILIKE sqlc.narg(counterparty)::text
           OR latest.description ILIKE sqlc.narg(counterparty)::text)
)
SELECT f.id, f.transaction_type, f.transaction_at, f.counterparty, l.bucket_id, k.source_account_id AS account_id, a.currency,
       SUM(l.amount)::numeric AS net
FROM families f
JOIN transaction_headers c ON c.id = f.id OR c.parent_id = f.id
JOIN bucket_transactions l ON l.transaction_id = c.id
JOIN buckets k ON k.id = l.bucket_id
JOIN bank_accounts a ON a.id = k.source_account_id
WHERE (sqlc.narg(account_ids)::text[] IS NULL OR k.source_account_id = ANY(sqlc.narg(account_ids)::text[]))
  AND (sqlc.narg(bucket_ids)::text[] IS NULL OR l.bucket_id = ANY(sqlc.narg(bucket_ids)::text[]))
GROUP BY f.id, f.transaction_type, f.transaction_at, f.counterparty, l.bucket_id, k.source_account_id, a.currency
HAVING SUM(l.amount) <> 0
ORDER BY f.transaction_at, f.id, l.bucket_id;

-- name: StatsBalanceLines :many
-- For balances: each account's sum of lines dated before from_at (at = null),
-- then its lines in [from_at, to_at) by their transaction's time, as
-- AccountBalancesBefore dates them. Every account the user has that isn't
-- deleted gets an opening row, even without lines.
SELECT a.id AS account_id, a.currency, NULL::timestamptz AS at,
       COALESCE(SUM(l.amount) FILTER (WHERE h.transaction_at < sqlc.arg(from_at)), 0)::numeric AS amount
FROM bank_accounts a
LEFT JOIN bank_transactions l ON l.account_id = a.id
LEFT JOIN transaction_headers h ON h.id = l.transaction_id
WHERE a.user_id = sqlc.arg(user_id) AND NOT a.deleted
  AND (sqlc.narg(account_ids)::text[] IS NULL OR a.id = ANY(sqlc.narg(account_ids)::text[]))
GROUP BY a.id, a.currency
UNION ALL
SELECT a.id, a.currency, h.transaction_at, l.amount
FROM bank_accounts a
JOIN bank_transactions l ON l.account_id = a.id
JOIN transaction_headers h ON h.id = l.transaction_id
WHERE a.user_id = sqlc.arg(user_id) AND NOT a.deleted
  AND (sqlc.narg(account_ids)::text[] IS NULL OR a.id = ANY(sqlc.narg(account_ids)::text[]))
  AND h.transaction_at >= sqlc.arg(from_at) AND h.transaction_at < sqlc.arg(to_at)
ORDER BY 1, 3 NULLS FIRST;

-- name: StatsAccounts :many
-- The accounts that get a series even without any sums: the user's accounts
-- that aren't deleted, or the filtered ones.
SELECT id, currency FROM bank_accounts
WHERE user_id = sqlc.arg(user_id) AND NOT deleted
  AND (sqlc.narg(account_ids)::text[] IS NULL OR id = ANY(sqlc.narg(account_ids)::text[]))
ORDER BY id;

-- name: StatsBuckets :many
-- The buckets that get a series even without any sums, with their
-- currency: the user's buckets that aren't deleted, or the filtered ones.
SELECT k.id, k.source_account_id AS account_id, a.currency FROM buckets k
JOIN bank_accounts a ON a.id = k.source_account_id
WHERE k.user_id = sqlc.arg(user_id) AND NOT k.deleted
  AND (sqlc.narg(account_ids)::text[] IS NULL OR k.source_account_id = ANY(sqlc.narg(account_ids)::text[]))
  AND (sqlc.narg(bucket_ids)::text[] IS NULL OR k.id = ANY(sqlc.narg(bucket_ids)::text[]))
ORDER BY k.id;

-- name: StatsCycles :many
-- The user's cycles that overlap [from_at, to_at), oldest first.
SELECT start_at, end_at FROM cycles
WHERE user_id = sqlc.arg(user_id) AND end_at > sqlc.arg(from_at) AND start_at < sqlc.arg(to_at)
ORDER BY start_at;

-- name: StatsBucketStarts :many
-- For the In/out/balance module (#126): each bucket's TF at from_at, the sum
-- of its lines whose family's original is dated before it (the dating of
-- StatsBucketNets, so start + nets = end). Every filtered bucket that isn't
-- deleted gets a row.
SELECT k.id AS bucket_id,
       COALESCE(SUM(l.amount) FILTER (WHERE o.transaction_at < sqlc.arg(from_at)), 0)::numeric AS start
FROM buckets k
LEFT JOIN bucket_transactions l ON l.bucket_id = k.id
LEFT JOIN transaction_headers c ON c.id = l.transaction_id
LEFT JOIN transaction_headers o ON o.id = COALESCE(c.parent_id, c.id)
WHERE k.user_id = sqlc.arg(user_id) AND NOT k.deleted
  AND (sqlc.narg(account_ids)::text[] IS NULL OR k.source_account_id = ANY(sqlc.narg(account_ids)::text[]))
  AND (sqlc.narg(bucket_ids)::text[] IS NULL OR k.id = ANY(sqlc.narg(bucket_ids)::text[]))
GROUP BY k.id
ORDER BY k.id;

-- name: StatsAccountStarts :many
-- For the In/out/balance module's balances (#187): each account's balance at
-- from_at, the sum of its lines whose family's original is dated before it
-- (the dating of StatsBankNets, so start + nets = end). Every filtered
-- account that isn't deleted gets a row.
SELECT a.id AS account_id,
       COALESCE(SUM(l.amount) FILTER (WHERE o.transaction_at < sqlc.arg(from_at)), 0)::numeric AS start
FROM bank_accounts a
LEFT JOIN bank_transactions l ON l.account_id = a.id
LEFT JOIN transaction_headers c ON c.id = l.transaction_id
LEFT JOIN transaction_headers o ON o.id = COALESCE(c.parent_id, c.id)
WHERE a.user_id = sqlc.arg(user_id) AND NOT a.deleted
  AND (sqlc.narg(account_ids)::text[] IS NULL OR a.id = ANY(sqlc.narg(account_ids)::text[]))
GROUP BY a.id
ORDER BY a.id;
