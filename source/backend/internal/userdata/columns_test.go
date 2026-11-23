package userdata

import (
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// TestIDColumns checks idColumns against the schema: every foreign key
// column of a per-user table, and every id column, must be listed, and
// every table with user data must be in tables.
func TestIDColumns(t *testing.T) {
	pool := testdb.New(t)
	rows, err := pool.Query(t.Context(), `
		SELECT c.conrelid::regclass::text, a.attname
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.contype IN ('f', 'p') AND c.connamespace = 'public'::regnamespace`)
	if err != nil {
		t.Fatal(err)
	}
	cols, err := pgx.CollectRows(rows, pgx.RowToStructByPos[struct{ Table, Column string }])
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cols {
		if !Known(c.Table) {
			continue
		}
		if _, ok := idColumns[c.Table][c.Column]; !ok {
			t.Errorf("%s.%s holds an ID but isn't in idColumns", c.Table, c.Column)
		}
	}
	var all []string
	if err := pool.QueryRow(t.Context(), `
		SELECT array_agg(DISTINCT table_name::text) FROM information_schema.columns
		WHERE table_schema = 'public' AND column_name IN ('user_id', 'account_id', 'bucket_id', 'transaction_id')`).Scan(&all); err != nil {
		t.Fatal(err)
	}
	for _, name := range all {
		// Not budget data: logins, and the app's log (#93), which isn't a user's.
		if !Known(name) && !slices.Contains([]string{"sessions", "password_links", "log_entries"}, name) {
			t.Errorf("table %s has user data but isn't in tables", name)
		}
	}
}

// TestColumns lists every per-user table's columns. When it fails, the
// schema of the exported data has changed: a new column with a default needs
// only a new line here, since older export files get the default. If a
// column was renamed or removed, or its meaning changed, also bump Format and
// teach upgrade to convert the older files.
func TestColumns(t *testing.T) {
	pool := testdb.New(t)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	cols, err := tableColumns(t.Context(), tx)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, tb := range tables {
		c := slices.Sorted(slices.Values(cols[tb.name]))
		lines = append(lines, tb.name+": "+strings.Join(c, ", "))
	}
	if got := strings.Join(lines, "\n"); got != exportedColumns {
		t.Errorf("the exported columns changed (see the comment); now:\n%s", got)
	}
}

const exportedColumns = `bank_accounts: account_type, bank, bsu_opened_year, bsu_set_up_at, card_credit_limit, card_default_account_id, card_due_day, card_minimum_payment, card_statement_day, created_at, currency, deleted, expected_income, id, modified_at, name, user_id
cycles: created_at, end_at, generated, id, modified_at, start_at, state, user_id
buckets: caf, cap_amount, cap_mode, cap_multiplier, created_at, deleted, id, importance, keep_funds, modified_at, name, negative_tf, overflow_destination, overflow_target_id, priority, refill_amount, refill_mode, source_account_id, user_id
savings_holders: account_id, bucket_id, created_at, deleted, goal, hold_mode, id, kind, min_amount, modified_at, name, note, user_id
savings_rules: created_at, id, modified_at, past_goal, priority, range_from, range_to, target_id, user_id
savings_budget_entries: account_id, amount, created_at, deleted, id, keep, modified_at, run_when, target_id, user_id
tags: created_at, id, name, user_id
transaction_headers: correction_type, counterparty, created_at, created_by, description, id, parent_id, replaces_id, transaction_at, transaction_type, triggers_refill, user_id
bank_transactions: account_id, amount, created_at, created_by, exchange_rate, id, original_amount, original_currency, transaction_id
bucket_transactions: amount, bucket_id, created_at, created_by, cycle_id, id, transaction_id
savings_transactions: account_id, amount, created_at, created_by, cycle_id, holder_id, id, transaction_id
transaction_tags: tag_id, transaction_id, user_id
refills: bucket_id, created_at, cycle_id, income_id, ovf_id, ref_id, trigger, user_id
savings_budget_runs: created_at, cycle_id, entry_id, income_id, reserved, svr_id, trigger, user_id, wanted
savings_follow_ons: created_at, follow_id, source_id, user_id
schedules: account_id, amount, counterparty, created_at, description, due_days, end_count, end_date, every, frequency, id, mode, name, next_at, next_index, paused, start_date, tags, time_of_day, time_zone, to_account_id, transaction_type, triggers_refill, updated_at, user_id
schedule_bucket_lines: amount, bucket_id, position, schedule_id, user_id
schedule_occurrences: created_at, detail, due_at, id, queued_at, reason, resolved_at, schedule_id, scheduled_at, state, transaction_id, user_id
notification_dismissals: dismissed_at, key, user_id`
