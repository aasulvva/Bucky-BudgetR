-- name: AccountFlows :many
-- Money in and out of each account over [from_at, to_at) (#90): income
-- (INC), expenses (EXP, as a positive amount) and transfers in and out (TRF).
-- A transaction counts on its original's date with its corrections' lines,
-- as the Transactions list shows it, so a reversed one adds up to 0. Only
-- accounts with such lines get a row.
WITH families AS (
    SELECT h.id, h.transaction_type, b.account_id, SUM(b.amount) AS net
    FROM transaction_headers h
    JOIN transaction_headers c ON c.id = h.id OR c.parent_id = h.id
    JOIN bank_transactions b ON b.transaction_id = c.id
    WHERE h.user_id = sqlc.arg(user_id) AND h.correction_type = 'none'
      AND h.transaction_type IN ('INC', 'EXP', 'TRF')
      AND h.transaction_at >= sqlc.arg(from_at) AND h.transaction_at < sqlc.arg(to_at)
    GROUP BY h.id, h.transaction_type, b.account_id
)
SELECT
    account_id,
    COALESCE(SUM(net) FILTER (WHERE transaction_type = 'INC'), 0)::numeric AS income,
    COALESCE(-SUM(net) FILTER (WHERE transaction_type = 'EXP'), 0)::numeric AS expenses,
    COALESCE(SUM(net) FILTER (WHERE transaction_type = 'TRF' AND net > 0), 0)::numeric AS transfers_in,
    COALESCE(-SUM(net) FILTER (WHERE transaction_type = 'TRF' AND net < 0), 0)::numeric AS transfers_out
FROM families
GROUP BY account_id
ORDER BY account_id;
