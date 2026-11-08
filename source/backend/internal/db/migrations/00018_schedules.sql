-- Scheduled and recurring transactions (#31, #153). A schedule holds a
-- transaction to record (like New transaction's) and when to record it: once,
-- or every N days, weeks, months or years from a start date, at a time of day
-- in a time zone. The scheduler records each occurrence when it comes due
-- (auto), or queues it for approval (approve). An occurrence that can't be
-- recorded is queued too, with the reason.
--
-- next_index is the number (from 0, counted from the start date) of the next
-- occurrence and next_at its time, or null when the schedule has ended.
-- start_date, time_of_day and end_date are wall times in time_zone; every
-- timestamptz is UTC.

-- +goose Up
CREATE TYPE schedule_mode AS ENUM ('auto', 'approve');
CREATE TYPE schedule_frequency AS ENUM ('once', 'day', 'week', 'month', 'year');
CREATE TYPE occurrence_state AS ENUM ('applied', 'queued', 'skipped');
CREATE TYPE occurrence_reason AS ENUM ('approval', 'no_active_cycle', 'outside_cycle', 'invalid');

CREATE TABLE schedules (
    id               text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{9}$'), -- ids.Schedule
    user_id          text NOT NULL REFERENCES users (id),
    name             text NOT NULL DEFAULT '' CHECK (name = btrim(name) AND length(name) <= 60),
    -- The transaction.
    transaction_type transaction_type NOT NULL CHECK (transaction_type IN ('INC', 'EXP', 'TRF')),
    account_id       text NOT NULL,
    to_account_id    text,
    amount           numeric(14, 2) NOT NULL CHECK (amount > 0),
    counterparty     text NOT NULL DEFAULT '' CHECK (length(counterparty) <= 200),
    tags             text[] NOT NULL DEFAULT '{}',
    -- Null leaves it to the user's income rules, as for an entered income.
    triggers_refill  boolean CHECK (NOT triggers_refill OR transaction_type = 'INC'),
    -- Auto-apply, or queue for approval with a due date due_days later.
    mode             schedule_mode NOT NULL,
    due_days         integer NOT NULL DEFAULT 3 CHECK (due_days BETWEEN 0 AND 60),
    -- The repeat.
    start_date       date NOT NULL,
    time_of_day      time NOT NULL,
    time_zone        text NOT NULL CHECK (time_zone <> ''),
    frequency        schedule_frequency NOT NULL,
    every            integer NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 366),
    end_count        integer CHECK (end_count >= 1),
    end_date         date,
    -- State.
    paused           boolean NOT NULL DEFAULT false,
    next_index       integer NOT NULL DEFAULT 0 CHECK (next_index >= 0),
    next_at          timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    CHECK (left(id, 6) = user_id),
    CHECK ((transaction_type = 'TRF') = (to_account_id IS NOT NULL)),
    CHECK (to_account_id IS NULL OR to_account_id <> account_id),
    CHECK (end_count IS NULL OR end_date IS NULL),
    CHECK (end_date IS NULL OR end_date >= start_date),
    FOREIGN KEY (account_id, user_id) REFERENCES bank_accounts (id, user_id),
    FOREIGN KEY (to_account_id, user_id) REFERENCES bank_accounts (id, user_id)
);

CREATE INDEX schedules_user_id_idx ON schedules (user_id);
CREATE INDEX schedules_due_idx ON schedules (next_at) WHERE NOT paused AND next_at IS NOT NULL;

-- The bucket lines of a schedule's income or expense, positive like
-- New transaction's.
CREATE TABLE schedule_bucket_lines (
    schedule_id text NOT NULL,
    bucket_id   text NOT NULL,
    user_id     text NOT NULL REFERENCES users (id),
    amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
    -- The order they were given in.
    position    integer NOT NULL,
    PRIMARY KEY (schedule_id, bucket_id),
    FOREIGN KEY (schedule_id, user_id) REFERENCES schedules (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (bucket_id, user_id) REFERENCES buckets (id, user_id)
);

CREATE INDEX schedule_bucket_lines_bucket_id_idx ON schedule_bucket_lines (bucket_id);

-- Each occurrence that came due: applied (with its transaction), queued for
-- approval, or skipped. Unique per schedule and time, so none is handled twice.
CREATE TABLE schedule_occurrences (
    id             text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{17}$'), -- ids.Occurrence
    schedule_id    text NOT NULL,
    user_id        text NOT NULL REFERENCES users (id),
    scheduled_at   timestamptz NOT NULL,
    state          occurrence_state NOT NULL,
    -- Why it was queued, and for 'invalid' the error.
    reason         occurrence_reason,
    detail         text NOT NULL DEFAULT '',
    queued_at      timestamptz,
    due_at         timestamptz,
    transaction_id text,
    resolved_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, scheduled_at),
    CHECK (left(id, 10) = schedule_id),
    CHECK (state <> 'applied' OR transaction_id IS NOT NULL),
    CHECK ((queued_at IS NULL) = (reason IS NULL) AND (queued_at IS NULL) = (due_at IS NULL)),
    CHECK (state <> 'queued' OR queued_at IS NOT NULL),
    FOREIGN KEY (schedule_id, user_id) REFERENCES schedules (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id, user_id) REFERENCES transaction_headers (id, user_id)
);

CREATE INDEX schedule_occurrences_user_state_idx ON schedule_occurrences (user_id, state, scheduled_at);
CREATE INDEX schedule_occurrences_transaction_id_idx ON schedule_occurrences (transaction_id);

-- +goose Down
DROP TABLE schedule_occurrences;
DROP TABLE schedule_bucket_lines;
DROP TABLE schedules;
DROP TYPE occurrence_reason;
DROP TYPE occurrence_state;
DROP TYPE schedule_frequency;
DROP TYPE schedule_mode;
