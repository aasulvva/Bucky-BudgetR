package allocation

import (
	"context"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// Run brings the stored CAF of the buckets funded from these accounts up to
// date, inside tx. For each account it first clamps every CAF to
// 0 ≤ CAF ≤ max(TF, 0), then recalculates the account with Allocate when
// force is set or Needed says so. Callers hold the user's lock
// (ledger.LockUser).
func Run(ctx context.Context, tx pgx.Tx, userID string, accountIDs []string, force bool) error {
	if len(accountIDs) == 0 {
		return nil
	}
	if err := ledger.LockUser(ctx, tx, userID); err != nil {
		return err
	}
	q := sqlc.New(tx)
	rows, err := q.ListAllocationBuckets(ctx, sqlc.ListAllocationBucketsParams{UserID: userID, AccountIds: accountIDs})
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	balances, err := balance.Accounts(ctx, tx, userID)
	if err != nil {
		return err
	}
	tf, err := balance.Buckets(ctx, tx, userID)
	if err != nil {
		return err
	}

	byAccount := map[string][]Bucket{}
	for _, r := range rows {
		byAccount[r.SourceAccountID] = append(byAccount[r.SourceAccountID], Bucket{
			ID: r.ID, TF: tf[r.ID], CAF: r.Caf, Priority: r.Priority, Importance: int(r.Importance),
		})
	}
	for account, buckets := range byAccount {
		available := balances[account]
		var want map[string]decimal.Decimal
		if force || Needed(available, buckets) {
			want = Allocate(available, buckets)
		}
		for _, b := range buckets {
			caf := Clamp(b)
			if want != nil {
				caf = want[b.ID]
			}
			if caf.Equal(b.CAF) {
				continue
			}
			if err := q.SetBucketCAF(ctx, sqlc.SetBucketCAFParams{ID: b.ID, Caf: caf}); err != nil {
				return fmt.Errorf("set CAF of bucket %s: %w", b.ID, err)
			}
		}
	}
	return nil
}

// AfterRecord is the ledger hook (ledger.Options.AfterRecord): it runs the
// routine for the accounts a transaction touched, directly or as the source
// of a bucket it touched.
func AfterRecord(ctx context.Context, tx pgx.Tx, t *ledger.Transaction) error {
	var accounts []string
	for _, l := range t.BankLines {
		accounts = append(accounts, l.AccountID)
	}
	if len(t.BucketLines) > 0 {
		ids := make([]string, len(t.BucketLines))
		for i, l := range t.BucketLines {
			ids[i] = l.BucketID
		}
		sources, err := sqlc.New(tx).BucketSourceAccounts(ctx, ids)
		if err != nil {
			return err
		}
		accounts = append(accounts, sources...)
	}
	slices.Sort(accounts)
	return Run(ctx, tx, t.Header.UserID, slices.Compact(accounts), false)
}
