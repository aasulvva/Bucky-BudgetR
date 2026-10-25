package ids_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

// takenTimes returns an insert func that reports the first n IDs as taken,
// and records every ID it was given.
func takenTimes(n int, tried *[]string) func(context.Context, string) (bool, error) {
	return func(_ context.Context, id string) (bool, error) {
		*tried = append(*tried, id)
		return len(*tried) > n, nil
	}
}

func TestInsertRetriesCollisions(t *testing.T) {
	var tried []string
	id, err := ids.Insert(t.Context(), ids.User, ids.NewUser, takenTimes(2, &tried))
	if err != nil {
		t.Fatal(err)
	}
	if len(tried) != 3 || id != tried[2] {
		t.Fatalf("tried %v, got %q", tried, id)
	}
	if tried[0] == tried[1] && tried[1] == tried[2] {
		t.Errorf("a new ID should be drawn on every attempt: %v", tried)
	}
}

func TestInsertGivesUp(t *testing.T) {
	var tried []string
	_, err := ids.Insert(t.Context(), ids.Account, ids.NewAccount, takenTimes(ids.MaxAttempts, &tried))
	if !errors.Is(err, ids.ErrIDSpaceExhausted) || len(tried) != ids.MaxAttempts {
		t.Fatalf("err = %v after %d attempts", err, len(tried))
	}
	if !strings.Contains(err.Error(), "account ID") {
		t.Errorf("error %q should name the kind", err)
	}
}

func TestInsertReturnsErrors(t *testing.T) {
	boom := errors.New("boom")
	_, err := ids.Insert(t.Context(), ids.User, ids.NewUser, func(context.Context, string) (bool, error) {
		return false, boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

// TestInsertWithDatabase checks the ON CONFLICT (id) DO NOTHING convention
// against PostgreSQL: a taken ID is retried inside a transaction without
// aborting it, while other unique violations still fail.
func TestInsertWithDatabase(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`CREATE TABLE things (id text PRIMARY KEY CHECK (id ~ '%s'), name text NOT NULL UNIQUE)`,
		ids.User.Pattern)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO things VALUES ('123456', 'first')`); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit
	insert := func(name string) func(context.Context, string) (bool, error) {
		return func(ctx context.Context, id string) (bool, error) {
			var got string
			err := tx.QueryRow(ctx,
				`INSERT INTO things (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`,
				id, name).Scan(&got)
			return ids.Inserted(err)
		}
	}

	// The first draw collides with the existing row.
	draws := []string{"123456", ids.NewUser()}
	gen := func() string { id := draws[0]; draws = draws[1:]; return id }
	id, err := ids.Insert(ctx, ids.User, gen, insert("second"))
	if err != nil {
		t.Fatal(err)
	}
	if id == "123456" {
		t.Fatal("reused the taken ID")
	}

	// A duplicate name is a real error, not a collision to retry.
	_, err = ids.Insert(ctx, ids.User, ids.NewUser, insert("first"))
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("want a unique violation, got %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM things`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("%d rows after rollback, want 1", n)
	}
}

// TestPatternsMatchPostgres checks that every Kind.Pattern works as a
// PostgreSQL CHECK: generated IDs pass, malformed ones are rejected.
func TestPatternsMatchPostgres(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	user, account := ids.NewUser(), ids.NewAccount()
	bucket := ids.NewBucket(user)

	for i, tc := range []struct {
		kind ids.Kind
		id   string
	}{
		{ids.User, user},
		{ids.Account, account},
		{ids.Cycle, ids.NewCycle(user)},
		{ids.Bucket, bucket},
		{ids.Transaction, ids.NewTransaction(time.Now())},
		{ids.BankLine, ids.NewBankLine(account)},
		{ids.BucketLine, ids.NewBucketLine(bucket)},
	} {
		table := pgx.Identifier{fmt.Sprintf("check_%d", i)}.Sanitize()
		if _, err := pool.Exec(ctx, fmt.Sprintf(
			`CREATE TABLE %s (id text PRIMARY KEY CHECK (id ~ '%s'))`, table, tc.kind.Pattern)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`INSERT INTO %s VALUES ($1)`, table), tc.id); err != nil {
			t.Errorf("%s ID %q rejected by its CHECK: %v", tc.kind.Name, tc.id, err)
		}
		_, err := pool.Exec(ctx, fmt.Sprintf(`INSERT INTO %s VALUES ($1)`, table), "0"+tc.id[1:]+"9")
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("%s: malformed ID not rejected by its CHECK: %v", tc.kind.Name, err)
		}
	}
}
