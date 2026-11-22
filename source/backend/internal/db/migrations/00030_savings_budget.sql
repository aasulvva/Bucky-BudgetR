-- The savings budget's fixed amounts (#234, spec §8.6).
--
-- An entry saves an amount per cycle from a source account, for a savings
-- target or (target_id NULL) the distributor, at cycle start, on income or
-- when the user asks. Like a bucket's refill, it runs at most once per cycle:
-- savings_budget_runs records each run with what it wanted, what it reserved
-- (the account's unallocated money can fall short) and its SVR, and the
-- income that triggered it, so reversing the income can undo it.

-- +goose Up
CREATE TYPE savings_budget_when AS ENUM ('cycle_start', 'on_income', 'manual');

CREATE TABLE savings_budget_entries (
    id          text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{9}$'), -- ids.SavingsBudgetEntry
    user_id     text NOT NULL REFERENCES users (id),
    account_id  text NOT NULL,
    -- NULL is the distributor.
    target_id   text,
    amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
    run_when    savings_budget_when NOT NULL,
    deleted     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    CHECK (left(id, 6) = user_id),
    FOREIGN KEY (account_id, user_id) REFERENCES bank_accounts (id, user_id),
    -- Deferred like buckets.overflow_target_id (00029), for export/import.
    FOREIGN KEY (target_id, user_id) REFERENCES savings_holders (id, user_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX savings_budget_entries_user_id_idx ON savings_budget_entries (user_id);
CREATE INDEX savings_budget_entries_account_id_idx ON savings_budget_entries (account_id);

CREATE TABLE savings_budget_runs (
    entry_id   text NOT NULL,
    cycle_id   text NOT NULL,
    user_id    text NOT NULL REFERENCES users (id),
    -- The entry's mode when it ran.
    trigger    savings_budget_when NOT NULL,
    -- The entry's amount then; 0 for an entry set up mid-cycle to start in
    -- the next cycle, which skips this one.
    wanted     numeric(14, 2) NOT NULL CHECK (wanted >= 0),
    reserved   numeric(14, 2) NOT NULL CHECK (reserved >= 0 AND reserved <= wanted),
    -- The SVR, when something was reserved.
    svr_id     text,
    -- The income that triggered an "On income" run.
    income_id  text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entry_id, cycle_id),
    FOREIGN KEY (entry_id, user_id) REFERENCES savings_budget_entries (id, user_id),
    FOREIGN KEY (cycle_id, user_id) REFERENCES cycles (id, user_id),
    FOREIGN KEY (svr_id, user_id) REFERENCES transaction_headers (id, user_id),
    FOREIGN KEY (income_id, user_id) REFERENCES transaction_headers (id, user_id),
    CHECK ((trigger = 'on_income') = (income_id IS NOT NULL)),
    CHECK ((svr_id IS NULL) = (reserved = 0))
);

CREATE INDEX savings_budget_runs_income_id_idx ON savings_budget_runs (income_id);
CREATE INDEX savings_budget_runs_cycle_id_idx ON savings_budget_runs (cycle_id);

-- +goose Down
DROP TABLE savings_budget_runs;
DROP TABLE savings_budget_entries;
DROP TYPE savings_budget_when;
