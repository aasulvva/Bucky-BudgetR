package allocation

import (
	"context"
	"fmt"
	"maps"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// Run brings the stored CAF of the buckets funded from these accounts up to
// date, inside tx. The buckets share the balance less the card debt held on
// the account (#261). For each account it limits every CAF to
// 0 ≤ CAF ≤ max(TF, 0), or recalculates the account with Allocate when force
// is set or Needed says so. Callers hold the user's lock (ledger.LockUser).
func Run(ctx context.Context, tx pgx.Tx, userID string, accountIDs []string, force bool) error {
	return run(ctx, tx, userID, accountIDs, force, nil)
}

// AfterRecord is the ledger hook (ledger.Options.AfterRecord): it runs the
// routine for the accounts a transaction touched, directly or as the source
// of a bucket it touched, and recalculates only those Follow says to.
func AfterRecord(ctx context.Context, tx pgx.Tx, t *ledger.Transaction) error {
	lines := map[string]*Lines{}
	at := func(account string) *Lines {
		if lines[account] == nil {
			lines[account] = &Lines{Buckets: map[string]decimal.Decimal{}}
		}
		return lines[account]
	}
	for _, l := range t.BankLines {
		a := at(l.AccountID)
		a.Banked = true
		a.Bank = a.Bank.Add(l.Amount)
	}
	// Card debt held on an account (#261) takes money from its buckets like
	// money going out: a card purchase from a bucket on it moves that
	// bucket's CAF only, as a debit card purchase would.
	for _, l := range t.CardLines {
		a := at(l.AccountID)
		a.Banked = true
		a.Bank = a.Bank.Sub(l.Amount)
	}
	// What a bucket owes its account for a waiting purchase (#264) counts as
	// money there: the purchase's part leaves the account's buckets as they
	// were, and a DBC moves its bucket's CAF as an expense would.
	if len(t.WaitingLines) > 0 {
		ids := make([]string, len(t.WaitingLines))
		for i, l := range t.WaitingLines {
			ids[i] = l.BucketID
		}
		rows, err := sqlc.New(tx).BucketAccounts(ctx, ids)
		if err != nil {
			return err
		}
		source := make(map[string]string, len(rows))
		for _, r := range rows {
			source[r.ID] = r.SourceAccountID
		}
		for _, l := range t.WaitingLines {
			a := at(source[l.BucketID])
			a.Banked = true
			a.Bank = a.Bank.Add(l.Amount)
		}
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
		for _, a := range sources {
			at(a)
		}
		for _, l := range t.BucketLines {
			for _, a := range lines {
				// Every account gets the line; Follow only looks at its own buckets.
				a.Buckets[l.BucketID] = a.Buckets[l.BucketID].Add(l.Amount)
			}
		}
	}
	return run(ctx, tx, t.Header.UserID, slices.Sorted(maps.Keys(lines)), false, lines)
}

func run(ctx context.Context, tx pgx.Tx, userID string, accountIDs []string, force bool, lines map[string]*Lines) error {
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
	debt, err := balance.CardDebt(ctx, tx, userID)
	if err != nil {
		return err
	}
	waiting, err := balance.Waiting(ctx, tx, userID)
	if err != nil {
		return err
	}
	tf, err := balance.Buckets(ctx, tx, userID)
	if err != nil {
		return err
	}

	byAccount := map[string][]Bucket{}
	stored := map[string]decimal.Decimal{}
	for _, r := range rows {
		byAccount[r.SourceAccountID] = append(byAccount[r.SourceAccountID], Bucket{
			ID: r.ID, TF: tf[r.ID], CAF: r.Caf, Priority: r.Priority, Importance: int(r.Importance),
		})
		stored[r.ID] = r.Caf
	}
	for account, buckets := range byAccount {
		available := balance.NewMoney(balances[account], waiting[account], debt[account], decimal.Zero, decimal.Zero).ForBuckets()
		recalc := force
		if l := lines[account]; l != nil && Follow(available, buckets, *l) {
			recalc = true
		}
		var want map[string]decimal.Decimal
		if recalc || Needed(available, buckets) {
			want = Allocate(available, buckets)
		}
		for _, b := range buckets {
			caf := Clamp(b)
			if want != nil {
				caf = want[b.ID]
			}
			if caf.Equal(stored[b.ID]) {
				continue
			}
			if err := q.SetBucketCAF(ctx, sqlc.SetBucketCAFParams{ID: b.ID, Caf: caf}); err != nil {
				return fmt.Errorf("set CAF of bucket %s: %w", b.ID, err)
			}
		}
	}
	return nil
}
