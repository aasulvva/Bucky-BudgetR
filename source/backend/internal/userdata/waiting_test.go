package userdata_test

import (
	"strings"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// A purchase that waits for its bucket (#264) follows it into the copy: its
// waiting charge and line take the copied bucket's ID as prefix, and the
// copy's account is owed the advance.
func TestWaitingFollows(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	carol := authtest.NewUser(t, e.pool, "carol")
	cur := must[sqlc.Cycle](t)(e.cycles.Create(ctx, carol.ID, now.Add(-24*time.Hour), now.Add(20*24*time.Hour)))
	must[sqlc.Cycle](t)(e.cycles.Start(ctx, carol.ID, cur.ID))
	next := must[sqlc.Cycle](t)(e.cycles.Create(ctx, carol.ID, now.Add(20*24*time.Hour), now.Add(50*24*time.Hour)))
	main := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{Name: "Main", OpeningBalance: dec("1000")}))
	games := must[buckets.Bucket](t)(e.buckets.Create(ctx, carol.ID, buckets.New{
		Name: "Games", SourceAccountID: main.ID, RefillAmount: dec("300"), CapMultiplier: dec("1"),
	}))
	must[transactions.Transaction](t)(e.tx.Create(ctx, carol.ID, transactions.New{
		Type: sqlc.TransactionTypeEXP, AccountID: main.ID, Amount: dec("250"), At: clock(),
		Buckets:    []transactions.BucketAmount{{BucketID: games.ID, Amount: dec("250")}},
		CountLater: &transactions.CountLater{When: sqlc.WaitingChargeWhenCycle, CycleID: next.ID},
	}))
	f, _ := e.file(t, carol.ID)
	if c, l := len(f.Data.Tables["waiting_charges"]), len(f.Data.Tables["waiting_lines"]); c != 1 || l != 1 {
		t.Fatalf("exported %d waiting charges and %d lines, want 1 and 1", c, l)
	}

	dave := authtest.NewUser(t, e.pool, "dave")
	must[userdata.Counts](t)(e.svc.Import(ctx, dave.ID, f))
	copied := must[[]accounts.Account](t)(e.accounts.List(ctx, dave.ID))
	if len(copied) != 1 || copied[0].Waiting.StringFixed(2) != "250.00" || copied[0].Unallocated.StringFixed(2) != "1000.00" {
		t.Fatalf("the copy %+v", copied)
	}
	out := must[userdata.File](t)(e.svc.Export(ctx, dave.ID)).Data.Tables
	bucket := must[[]buckets.Bucket](t)(e.buckets.List(ctx, dave.ID))[0].ID
	for _, table := range []string{"waiting_charges", "waiting_lines"} {
		for _, r := range out[table] {
			if !strings.HasPrefix(r["id"].(string), bucket) || r["bucket_id"] != bucket {
				t.Errorf("dave's %s %v", table, r)
			}
		}
	}
	if c := out["waiting_charges"][0]; c["cycle_id"] == next.ID || c["cycle_id"] == nil {
		t.Errorf("dave's charge keeps carol's cycle: %v", c)
	}
}
