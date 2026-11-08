-- name: ListDismissals :many
SELECT key FROM notification_dismissals WHERE user_id = $1;

-- name: Dismiss :exec
INSERT INTO notification_dismissals (user_id, key, dismissed_at) VALUES ($1, $2, $3)
ON CONFLICT (user_id, key) DO NOTHING;

-- name: ForgetDismissals :exec
DELETE FROM notification_dismissals WHERE user_id = $1 AND key = ANY (sqlc.arg(keys)::text[]);

-- name: NotificationSettings :one
-- The user's notifications preference, or '{}' when unset.
SELECT COALESCE(preferences -> 'notifications', '{}')::jsonb FROM users WHERE id = $1;

-- name: QueueSummary :one
-- The user's queued occurrences: how many, how many are overdue, and the
-- newest one (by queue time).
SELECT count(*)::int AS queued,
    (count(*) FILTER (WHERE due_at < sqlc.arg(now)::timestamptz))::int AS overdue,
    COALESCE((array_agg(id ORDER BY queued_at DESC, id DESC))[1], '')::text AS newest_id,
    COALESCE(max(queued_at), '0001-01-01 00:00:00+00')::timestamptz AS newest_at
FROM schedule_occurrences
WHERE user_id = sqlc.arg(user_id) AND state = 'queued';

-- name: AccountsToAdjust :many
-- The user's investment and fund accounts that existed before since (made
-- before it, or with a transaction dated before it: created_at is the real
-- time, transactions follow the business clock) with no balance adjustment
-- (BLA) from since on.
SELECT a.id FROM bank_accounts a
WHERE a.user_id = $1 AND NOT a.deleted AND a.account_type IN ('investment', 'fund')
    AND (a.created_at < sqlc.arg(since)::timestamptz OR EXISTS (
        SELECT 1 FROM bank_transactions bt
        JOIN transaction_headers th ON th.id = bt.transaction_id
        WHERE bt.account_id = a.id AND th.transaction_at < sqlc.arg(since)::timestamptz
    ))
    AND NOT EXISTS (
        SELECT 1 FROM bank_transactions bt
        JOIN transaction_headers th ON th.id = bt.transaction_id
        WHERE bt.account_id = a.id AND th.transaction_type = 'BLA'
            AND th.transaction_at >= sqlc.arg(since)::timestamptz
    )
ORDER BY a.name, a.id;

-- name: AccountCurrencies :many
SELECT id, currency FROM bank_accounts WHERE user_id = $1;
