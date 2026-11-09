package accounts_test

import (
	"errors"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
)

// fund gives a bucket target funds with a bucket adjustment (BUA) in the
// active cycle.
func (e env) fund(t *testing.T, bucket, amount string) {
	t.Helper()
	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeBUA, At: now,
		BucketLines: []ledger.BucketLine{{BucketID: bucket, Amount: dec(amount)}},
	}); err != nil {
		t.Fatal(err)
	}
}

// tf is a bucket's target funds: the sum of its lines.
func (e env) tf(t *testing.T, bucket string) decimal.Decimal {
	t.Helper()
	var sum decimal.Decimal
	if err := e.pool.QueryRow(t.Context(),
		"SELECT coalesce(sum(amount), 0) FROM bucket_transactions WHERE bucket_id = $1", bucket).Scan(&sum); err != nil {
		t.Fatal(err)
	}
	return sum
}

// live reports whether a bucket (or, with table "bank_accounts", an account) isn't deleted.
func (e env) live(t *testing.T, table, id string) bool {
	t.Helper()
	var n int
	if err := e.pool.QueryRow(t.Context(),
		"SELECT count(*) FROM "+table+" WHERE id = $1 AND NOT deleted", id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

func (e env) activeCycle(t *testing.T) string {
	t.Helper()
	return ledgertest.Cycle(t, e.pool, e.user, now.Add(-24*time.Hour), now.Add(14*24*time.Hour), "active")
}

// Deleting an account can delete its buckets too (#137): what's left in them
// is released first, so it's part of the money transferred.
func TestDeleteWithBuckets(t *testing.T) {
	ctx := t.Context()

	t.Run("deletes and moves", func(t *testing.T) {
		e := setup(t)
		e.activeCycle(t)
		a := e.create(t, "Old", "1000")
		to := e.create(t, "New", "")
		gifts := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		empty := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		kept := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		e.fund(t, gifts, "300")
		bua := e.count(t, sqlc.TransactionTypeBUA)

		err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{
			DeleteBuckets: []string{gifts, empty, gifts}, // a repeat counts once
			BucketSources: map[string]string{kept: to.ID},
			Remaining:     &accounts.Remaining{TransferTo: to.ID},
		})
		if err != nil {
			t.Fatal(err)
		}
		if e.live(t, "buckets", gifts) || e.live(t, "buckets", empty) || e.live(t, "bank_accounts", a.ID) {
			t.Error("the deleted buckets or the account are still there")
		}
		if !e.live(t, "buckets", kept) {
			t.Error("the moved bucket was deleted")
		}
		// One release, for the bucket with funds; its transactions stay.
		if n := e.count(t, sqlc.TransactionTypeBUA); n != bua+1 {
			t.Errorf("%d BUA transactions, want %d", n, bua+1)
		}
		if got := e.tf(t, gifts); !got.IsZero() {
			t.Errorf("released bucket's TF %s, want 0", got)
		}
		// The whole balance, the bucket's 300 included, was transferred.
		if got := e.balance(t, to.ID); !got.Equal(dec("1000")) {
			t.Errorf("transferred %s, want 1000", got)
		}
		var source string
		if err := e.pool.QueryRow(ctx, "SELECT source_account_id FROM buckets WHERE id = $1", kept).Scan(&source); err != nil {
			t.Fatal(err)
		}
		if source != to.ID {
			t.Errorf("moved bucket's source %s, want %s", source, to.ID)
		}
	})

	t.Run("every bucket needs exactly one choice", func(t *testing.T) {
		e := setup(t)
		a := e.create(t, "Old", "")
		to := e.create(t, "New", "")
		b1 := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		b2 := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		foreign := ledgertest.Bucket(t, e.pool, e.user, to.ID)

		err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{DeleteBuckets: []string{b1}})
		var has *accounts.HasBucketsError
		if !errors.As(err, &has) || len(has.BucketIDs) != 1 || has.BucketIDs[0] != b2 {
			t.Errorf("got %v, want HasBucketsError(%s)", err, b2)
		}
		for name, st := range map[string]accounts.Settlement{
			"both":    {DeleteBuckets: []string{b1, b2}, BucketSources: map[string]string{b1: to.ID}},
			"foreign": {DeleteBuckets: []string{b1, b2, foreign}},
		} {
			if err := e.svc.Delete(ctx, e.user, a.ID, st); !errors.Is(err, accounts.ErrInvalid) {
				t.Errorf("%s: got %v, want ErrInvalid", name, err)
			}
		}
		if !e.live(t, "bank_accounts", a.ID) || !e.live(t, "buckets", b1) || !e.live(t, "buckets", foreign) {
			t.Error("a refused delete changed something")
		}
	})

	t.Run("releasing needs an active cycle", func(t *testing.T) {
		e := setup(t)
		cycle := e.activeCycle(t)
		a := e.create(t, "Old", "")
		full := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		empty := ledgertest.Bucket(t, e.pool, e.user, a.ID)
		e.fund(t, full, "50")
		if _, err := e.pool.Exec(ctx, "UPDATE cycles SET state = 'finished' WHERE id = $1", cycle); err != nil {
			t.Fatal(err)
		}

		err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{DeleteBuckets: []string{full, empty}})
		if !errors.Is(err, ledger.ErrNoActiveCycle) {
			t.Fatalf("got %v, want ErrNoActiveCycle", err)
		}
		if !e.live(t, "bank_accounts", a.ID) || !e.live(t, "buckets", full) || !e.live(t, "buckets", empty) {
			t.Error("a refused delete changed something")
		}

		// A bucket with nothing left needs no cycle.
		other := e.create(t, "Other", "")
		if err := e.svc.Delete(ctx, e.user, a.ID, accounts.Settlement{
			DeleteBuckets: []string{empty},
			BucketSources: map[string]string{full: other.ID},
		}); err != nil {
			t.Fatal(err)
		}
		if e.live(t, "buckets", empty) || !e.live(t, "buckets", full) {
			t.Error("want the empty bucket deleted and the full one moved")
		}
	})
}
