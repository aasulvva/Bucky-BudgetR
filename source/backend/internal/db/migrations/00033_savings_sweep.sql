-- Sweeps (#235, spec §8.6): a savings budget entry that sends what the
-- account has unallocated above keep to savings, after the account's buckets
-- are refilled or at cycle end. It has keep instead of an amount. An account
-- has at most one live sweep per mode.

-- +goose Up
ALTER TABLE savings_budget_entries
    DROP CONSTRAINT savings_budget_entries_amount_check,
    ALTER COLUMN amount DROP NOT NULL,
    ADD COLUMN keep numeric(14, 2),
    ADD CONSTRAINT savings_budget_entries_kind_check CHECK (
        CASE WHEN run_when IN ('after_refills', 'cycle_end')
            THEN amount IS NULL AND keep IS NOT NULL AND keep >= 0
            ELSE amount IS NOT NULL AND amount > 0 AND keep IS NULL
        END
    );

CREATE UNIQUE INDEX savings_budget_entries_one_sweep_idx ON savings_budget_entries (account_id, run_when)
    WHERE NOT deleted AND run_when IN ('after_refills', 'cycle_end');

-- +goose Down
DELETE FROM savings_budget_runs r USING savings_budget_entries e
WHERE r.entry_id = e.id AND e.run_when IN ('after_refills', 'cycle_end');
DELETE FROM savings_budget_entries WHERE run_when IN ('after_refills', 'cycle_end');
DROP INDEX savings_budget_entries_one_sweep_idx;
ALTER TABLE savings_budget_entries
    DROP CONSTRAINT savings_budget_entries_kind_check,
    DROP COLUMN keep,
    ALTER COLUMN amount SET NOT NULL,
    ADD CONSTRAINT savings_budget_entries_amount_check CHECK (amount > 0);
