package balance

import (
	"context"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// Money is how an account's balance is used (spec §7, §8): what's held there
// for credit card debt, what its buckets' CAF takes, what's reserved for
// savings, and what's left.
type Money struct {
	Balance decimal.Decimal
	// CardHolds is what's held on the account per credit card (#261), by
	// card ID: sums that aren't 0, below 0 when a refund took more off than
	// was held.
	CardHolds map[string]decimal.Decimal
	// CardDebt is Σ CardHolds, at least 0, and CardCovered the part of it the
	// balance covers. Card debt comes first: buckets get only what's left.
	CardDebt    decimal.Decimal
	CardCovered decimal.Decimal
	// Allocated is Σ CAF of the account's live buckets.
	Allocated decimal.Decimal
	// Reserved is Σ savings lines on the account: what's held there for
	// savings targets and the distributor (#231).
	Reserved decimal.Decimal
	// Covered is the part of Reserved the balance covers. Card debt and
	// buckets come first, so reservations take only what's left after them.
	Covered decimal.Decimal
	// Unallocated is the balance less CardCovered, Allocated and Covered.
	Unallocated decimal.Decimal
}

// Uncovered is the part of the reservations the balance doesn't cover.
func (m Money) Uncovered() decimal.Decimal { return m.Reserved.Sub(m.Covered) }

// CardUncovered is the part of the card debt the balance doesn't cover.
func (m Money) CardUncovered() decimal.Decimal { return m.CardDebt.Sub(m.CardCovered) }

// ForBuckets is what the account's buckets can have (spec §7): the balance
// less the card debt held on it.
func (m Money) ForBuckets() decimal.Decimal { return m.Balance.Sub(m.CardDebt) }

// NewMoney works out an account's Money from its balance, its card holds,
// Σ CAF and Σ savings lines.
func NewMoney(bal decimal.Decimal, holds map[string]decimal.Decimal, allocated, reserved decimal.Decimal) Money {
	debt := decimal.Zero
	for _, h := range holds {
		debt = debt.Add(h)
	}
	debt = decimal.Max(debt, decimal.Zero)
	cardCovered := decimal.Max(decimal.Zero, decimal.Min(debt, bal))
	left := bal.Sub(cardCovered).Sub(allocated)
	covered := decimal.Max(decimal.Zero, decimal.Min(reserved, left))
	return Money{
		Balance: bal, CardHolds: holds, CardDebt: debt, CardCovered: cardCovered,
		Allocated: allocated, Reserved: reserved, Covered: covered,
		Unallocated: left.Sub(covered),
	}
}

// CardDebt returns what's held for the user's live credit cards on each
// account (#261): by account ID, then card ID.
func CardDebt(ctx context.Context, db sqlc.DBTX, userID string) (map[string]map[string]decimal.Decimal, error) {
	rows, err := sqlc.New(db).CardDebtHeld(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]decimal.Decimal{}
	for _, r := range rows {
		if out[r.AccountID] == nil {
			out[r.AccountID] = map[string]decimal.Decimal{}
		}
		out[r.AccountID][r.CardID] = r.Held
	}
	return out, nil
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
	holds, err := CardDebt(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]Money, len(balances))
	for id, bal := range balances {
		out[id] = NewMoney(bal, holds[id], caf[id], held[id])
	}
	return out, nil
}
