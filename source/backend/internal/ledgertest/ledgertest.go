// Package ledgertest creates the bank accounts, cycles and buckets that
// ledger tests need, as bare rows. Create users with authtest.NewUser.
package ledgertest

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
)

// Account creates a bank account for userID in currency (NOK if empty) and
// returns its ID.
func Account(t testing.TB, pool *pgxpool.Pool, userID, currency string) string {
	t.Helper()
	if currency == "" {
		currency = "NOK"
	}
	return insert(t, ids.Account, ids.NewAccount, func(ctx context.Context, id string) error {
		return pool.QueryRow(ctx, `INSERT INTO bank_accounts (id, user_id, name, currency) VALUES ($1, $2, 'Account ' || $1, $3)
			ON CONFLICT (id) DO NOTHING RETURNING id`, id, userID, currency).Scan(&id)
	})
}

// UnusedAccountID returns a valid account ID that no account has. Account
// IDs are random, so a fixed one like "9999" can belong to a test's account.
func UnusedAccountID(t testing.TB, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `SELECT n::text FROM generate_series(9999, 1000, -1) n
		WHERE NOT EXISTS (SELECT 1 FROM bank_accounts WHERE id = n::text) LIMIT 1`).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// Cycle creates a cycle for userID from start up to (not including) end, in
// the given state ("future", "active" or "finished") and returns its ID.
func Cycle(t testing.TB, pool *pgxpool.Pool, userID string, start, end time.Time, state string) string {
	t.Helper()
	return insert(t, ids.Cycle, func() string { return ids.NewCycle(userID) }, func(ctx context.Context, id string) error {
		return pool.QueryRow(ctx, `INSERT INTO cycles (id, user_id, start_at, end_at, state) VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (id) DO NOTHING RETURNING id`, id, userID, start, end, state).Scan(&id)
	})
}

// Bucket creates a bucket for userID funded from accountID and returns its ID.
func Bucket(t testing.TB, pool *pgxpool.Pool, userID, accountID string) string {
	t.Helper()
	return insert(t, ids.Bucket, func() string { return ids.NewBucket(userID) }, func(ctx context.Context, id string) error {
		return pool.QueryRow(ctx, `INSERT INTO buckets (id, user_id, name, source_account_id) VALUES ($1, $2, 'Bucket ' || $1, $3)
			ON CONFLICT (id) DO NOTHING RETURNING id`, id, userID, accountID).Scan(&id)
	})
}

// Delete soft-deletes an account or bucket (table is "bank_accounts" or
// "buckets").
func Delete(t testing.TB, pool *pgxpool.Pool, table, id string) {
	t.Helper()
	if table != "bank_accounts" && table != "buckets" {
		t.Fatalf("ledgertest.Delete: unknown table %q", table)
	}
	if _, err := pool.Exec(context.Background(), "UPDATE "+table+" SET deleted = true WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
}

func insert(t testing.TB, kind ids.Kind, gen func() string, insert func(ctx context.Context, id string) error) string {
	t.Helper()
	id, err := ids.Insert(context.Background(), kind, gen, func(ctx context.Context, id string) (bool, error) {
		return ids.Inserted(insert(ctx, id))
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}
