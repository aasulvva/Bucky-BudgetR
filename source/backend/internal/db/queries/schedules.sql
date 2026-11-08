-- name: CreateSchedule :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO schedules (
    id, user_id, name, transaction_type, account_id, to_account_id, amount, counterparty, tags,
    triggers_refill, mode, due_days, start_date, time_of_day, time_zone, frequency, every,
    end_count, end_date, paused, next_index, next_at, description
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: UpdateSchedule :one
UPDATE schedules SET
    name = $3, transaction_type = $4, account_id = $5, to_account_id = $6, amount = $7,
    counterparty = $8, tags = $9, triggers_refill = $10, mode = $11, due_days = $12,
    start_date = $13, time_of_day = $14, time_zone = $15, frequency = $16, every = $17,
    end_count = $18, end_date = $19, paused = $20, next_index = $21, next_at = $22, description = $23,
    updated_at = now()
WHERE id = $1 AND user_id = $2
RETURNING *;

-- name: ListSchedules :many
-- The user's schedules: the next due first, then the ended ones, newest first.
SELECT * FROM schedules WHERE user_id = $1
ORDER BY next_at NULLS LAST, created_at DESC, id;

-- name: GetSchedule :one
SELECT * FROM schedules WHERE id = $1 AND user_id = $2;

-- name: GetScheduleForUpdate :one
SELECT * FROM schedules WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: DeleteSchedule :execrows
-- Its bucket lines and occurrences go with it; its transactions stay.
DELETE FROM schedules WHERE id = $1 AND user_id = $2;

-- name: AddScheduleBucketLine :exec
INSERT INTO schedule_bucket_lines (schedule_id, bucket_id, user_id, amount, position) VALUES ($1, $2, $3, $4, $5);

-- name: DeleteScheduleBucketLines :exec
DELETE FROM schedule_bucket_lines WHERE schedule_id = $1 AND user_id = $2;

-- name: ListScheduleBucketLines :many
-- The bucket lines of these schedules, in the order they were given.
SELECT * FROM schedule_bucket_lines WHERE schedule_id = ANY(sqlc.arg(ids)::text[])
ORDER BY schedule_id, position;

-- name: UsersWithDueSchedules :many
-- An approve schedule's occurrence comes due (is queued) due_days before
-- its time; see schedules.handleFrom.
SELECT DISTINCT user_id FROM schedules
WHERE NOT paused AND next_at IS NOT NULL
  AND next_at - make_interval(days => CASE WHEN mode = 'approve' THEN due_days ELSE 0 END) <= sqlc.arg(now)::timestamptz;

-- name: DueSchedulesForUpdate :many
-- The user's schedules with an occurrence due, locked while the scheduler
-- handles them.
SELECT * FROM schedules
WHERE user_id = $1 AND NOT paused AND next_at IS NOT NULL
  AND next_at - make_interval(days => CASE WHEN mode = 'approve' THEN due_days ELSE 0 END) <= sqlc.arg(now)::timestamptz
ORDER BY next_at, id
FOR UPDATE;

-- name: AdvanceSchedule :exec
UPDATE schedules SET next_index = $2, next_at = $3 WHERE id = $1;

-- name: OccurrenceExists :one
SELECT EXISTS (SELECT 1 FROM schedule_occurrences WHERE schedule_id = $1 AND scheduled_at = $2);

-- name: CreateOccurrence :one
-- Use with ids.Insert: a taken ID returns no row.
INSERT INTO schedule_occurrences (
    id, schedule_id, user_id, scheduled_at, state, reason, detail, queued_at, due_at, transaction_id, resolved_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (id) DO NOTHING
RETURNING *;

-- name: ListOccurrences :many
-- A page of the user's occurrences, newest first. Null filters match all.
SELECT * FROM schedule_occurrences
WHERE user_id = $1
    AND (sqlc.narg(state)::occurrence_state IS NULL OR state = sqlc.narg(state))
    AND (sqlc.narg(schedule_id)::text IS NULL OR schedule_id = sqlc.narg(schedule_id))
    AND (sqlc.narg(before_at)::timestamptz IS NULL
        OR (scheduled_at, id) < (sqlc.narg(before_at)::timestamptz, sqlc.narg(before_id)::text))
ORDER BY scheduled_at DESC, id DESC
LIMIT sqlc.arg(row_limit);

-- name: UserTimeZone :one
-- The user's time_zone preference, or '' when unset.
SELECT COALESCE(preferences ->> 'time_zone', '')::text FROM users WHERE id = $1;

-- name: GetOccurrence :one
SELECT * FROM schedule_occurrences WHERE id = $1 AND user_id = $2;

-- name: GetOccurrenceForUpdate :one
SELECT * FROM schedule_occurrences WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: ResolveOccurrence :one
-- Approves or skips a queued occurrence.
UPDATE schedule_occurrences
SET state = sqlc.arg(state), transaction_id = sqlc.narg(transaction_id), resolved_at = sqlc.arg(resolved_at)
WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id) AND state = 'queued'
RETURNING *;
