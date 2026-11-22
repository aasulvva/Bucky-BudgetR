-- Balances and bucket figures are calculated from ledger lines (spec §2),
-- never stored. Every account or bucket of the user gets a row, even with no
-- lines, including deleted ones (for history).

-- name: AccountBalances :many
SELECT a.id, COALESCE(SUM(l.amount), 0)::numeric AS balance
FROM bank_accounts a
LEFT JOIN bank_transactions l ON l.account_id = a.id
WHERE a.user_id = $1
GROUP BY a.id
ORDER BY a.id;

-- name: AccountBalancesBefore :many
-- Counts only transactions dated before the given moment.
SELECT a.id, COALESCE(SUM(l.amount) FILTER (WHERE h.transaction_at < sqlc.arg(before)), 0)::numeric AS balance
FROM bank_accounts a
LEFT JOIN bank_transactions l ON l.account_id = a.id
LEFT JOIN transaction_headers h ON h.id = l.transaction_id
WHERE a.user_id = sqlc.arg(user_id)
GROUP BY a.id
ORDER BY a.id;

-- name: BucketTargetFunds :many
SELECT b.id, COALESCE(SUM(l.amount), 0)::numeric AS tf
FROM buckets b
LEFT JOIN bucket_transactions l ON l.bucket_id = b.id
WHERE b.user_id = $1
GROUP BY b.id
ORDER BY b.id;

-- name: CycleExists :one
SELECT EXISTS (SELECT 1 FROM cycles WHERE id = $1 AND user_id = $2);

-- name: BucketCycleSums :many
-- Per bucket: lines from cycles that started before this one, and this
-- cycle's lines by type.
SELECT
    b.id,
    COALESCE(SUM(l.amount) FILTER (WHERE c.start_at < this.start_at), 0)::numeric AS start,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'REF'), 0)::numeric AS refills,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'INC'), 0)::numeric AS income,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'OPF'), 0)::numeric AS opening,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type IN ('BUA', 'SVB')), 0)::numeric AS adjustments,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'BAT'), 0)::numeric AS transfers,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'EXP'), 0)::numeric AS expenses,
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'OVF'), 0)::numeric AS overflow,
    -- The overflow of refills that pushed TF above BC (and its reversals),
    -- rather than of the cycle's end.
    COALESCE(SUM(l.amount) FILTER (WHERE l.cycle_id = this.id AND h.transaction_type = 'OVF' AND rf.ovf_id IS NOT NULL), 0)::numeric AS capped
FROM cycles this
JOIN buckets b ON b.user_id = this.user_id
LEFT JOIN bucket_transactions l ON l.bucket_id = b.id
LEFT JOIN transaction_headers h ON h.id = l.transaction_id
LEFT JOIN cycles c ON c.id = l.cycle_id
LEFT JOIN refills rf ON rf.user_id = this.user_id AND rf.ovf_id = COALESCE(h.parent_id, h.id)
WHERE this.id = sqlc.arg(cycle_id) AND this.user_id = sqlc.arg(user_id)
GROUP BY b.id
ORDER BY b.id;
