-- The savings budget's fixed amounts (#234, spec §8.6). Callers hold the
-- user's lock (ledger.LockUser), so checking whether an entry ran in a cycle
-- and recording the run can't race.

-- name: ListBudgetEntries :many
-- The user's live entries, oldest first; stopped is an entry whose target
-- went away.
SELECT e.*, (e.target_id IS NOT NULL AND COALESCE(h.deleted, true))::boolean AS stopped
FROM savings_budget_entries e
LEFT JOIN savings_holders h ON h.id = e.target_id
WHERE e.user_id = $1 AND NOT e.deleted
ORDER BY e.created_at, e.id;

-- name: GetBudgetEntryForUpdate :one
SELECT * FROM savings_budget_entries WHERE id = $1 AND user_id = $2 AND NOT deleted FOR UPDATE;

-- name: CreateBudgetEntry :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO savings_budget_entries (id, user_id, account_id, target_id, amount, run_when)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: UpdateBudgetEntry :one
UPDATE savings_budget_entries SET target_id = $3, amount = $4, run_when = $5, modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted
RETURNING *;

-- name: DeleteBudgetEntry :execrows
UPDATE savings_budget_entries SET deleted = true, modified_at = now()
WHERE id = $1 AND user_id = $2 AND NOT deleted;

-- name: DeleteBudgetEntriesOfAccount :exec
UPDATE savings_budget_entries SET deleted = true, modified_at = now()
WHERE account_id = $1 AND user_id = $2 AND NOT deleted;

-- name: ListBudgetEntriesToRun :many
-- The user's live entries with this mode that haven't run in the cycle,
-- optionally only those from one account; a stopped entry doesn't run.
SELECT e.* FROM savings_budget_entries e
LEFT JOIN savings_holders h ON h.id = e.target_id
WHERE e.user_id = sqlc.arg(user_id) AND NOT e.deleted AND e.run_when = sqlc.arg(run_when)
    AND (sqlc.narg(account_id)::text IS NULL OR e.account_id = sqlc.narg(account_id))
    AND (e.target_id IS NULL OR NOT h.deleted)
    AND NOT EXISTS (SELECT 1 FROM savings_budget_runs r WHERE r.entry_id = e.id AND r.cycle_id = sqlc.arg(cycle_id))
ORDER BY e.created_at, e.id;

-- name: GetBudgetRun :one
SELECT * FROM savings_budget_runs WHERE entry_id = $1 AND cycle_id = $2;

-- name: CreateBudgetRun :exec
INSERT INTO savings_budget_runs (entry_id, cycle_id, user_id, trigger, wanted, reserved, svr_id, income_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListBudgetRunsByIncome :many
-- The runs an income triggered in a cycle.
SELECT * FROM savings_budget_runs WHERE income_id = $1 AND cycle_id = $2 ORDER BY entry_id;

-- name: ListBudgetRuns :many
-- The user's runs in a cycle, with their SVR's time.
SELECT r.*, h.transaction_at AS svr_at
FROM savings_budget_runs r
LEFT JOIN transaction_headers h ON h.id = r.svr_id
WHERE r.user_id = $1 AND r.cycle_id = $2
ORDER BY r.entry_id;

-- name: DeleteBudgetRun :exec
DELETE FROM savings_budget_runs WHERE entry_id = $1 AND cycle_id = $2;
