package balance

import (
	"context"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// Money is how an account's balance is used (spec §7, §8): what its buckets'
// CAF takes, what's reserved for savings, and what's left.
type Money struct {
	Balance decimal.Decimal
	// Allocated is Σ CAF of the account's live buckets.
	Allocated decimal.Decimal
	// Reserved is Σ savings lines on the account: what's held there for
	// savings targets and the distributor (#231).
	Reserved decimal.Decimal
	// Covered is the part of Reserved the balance covers. Buckets are funded
	// first, so reservations take only what's left after their CAF.
	Covered decimal.Decimal
	// Unallocated is the balance less Allocated and Covered.
	Unallocated decimal.Decimal
}

// Uncovered is the part of the reservations the balance doesn't cover.
func (m Money) Uncovered() decimal.Decimal { return m.Reserved.Sub(m.Covered) }

// NewMoney works out an account's Money from its balance, Σ CAF and Σ savings
// lines.
func NewMoney(bal, allocated, reserved decimal.Decimal) Money {
	covered := decimal.Max(decimal.Zero, decimal.Min(reserved, bal.Sub(allocated)))
	return Money{
		Balance: bal, Allocated: allocated, Reserved: reserved, Covered: covered,
		Unallocated: bal.Sub(allocated).Sub(covered),
	}
}

// AccountMoney returns the Money of each of the user's accounts, by account
// ID (deleted ones too, like Accounts).
func AccountMoney(ctx context.Context, db sqlc.DBTX, userID string) (map[string]Money, error) {
	balances, err := Accounts(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	q := sqlc.New(db)
	allocated, err := q.AllocatedByAccount(ctx, userID)
	if err != nil {
		return nil, err
	}
	reserved, err := q.ReservedByAccount(ctx, userID)
	if err != nil {
		return nil, err
	}
	caf := make(map[string]decimal.Decimal, len(allocated))
	for _, r := range allocated {
		caf[r.SourceAccountID] = r.Allocated
	}
	held := make(map[string]decimal.Decimal, len(reserved))
	for _, r := range reserved {
		held[r.AccountID] = r.Reserved
	}
	out := make(map[string]Money, len(balances))
	for id, bal := range balances {
		out[id] = NewMoney(bal, caf[id], held[id])
	}
	return out, nil
}
