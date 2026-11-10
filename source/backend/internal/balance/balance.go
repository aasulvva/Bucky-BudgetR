// Package balance calculates account balances, bucket TF and a bucket's
// figures for a cycle from the ledger. None of it is stored (spec §2).
//
// Every account or bucket of the user is included, even with no lines (0)
// and even when deleted, so callers can show history. The account and
// bucket endpoints (#12, #14) pick what they need.
package balance

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// ErrNotFound means the cycle doesn't exist or isn't the user's.
var ErrNotFound = errors.New("not found")

// Accounts returns the current balance of each of the user's accounts, by
// account ID: the sum of all its bank lines.
func Accounts(ctx context.Context, db sqlc.DBTX, userID string) (map[string]decimal.Decimal, error) {
	rows, err := sqlc.New(db).AccountBalances(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]decimal.Decimal, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Balance
	}
	return out, nil
}

// AccountsBefore returns each account's balance just before t: only
// transactions dated before t count. Pass the start of a day to get the
// balance at the end of the previous day.
func AccountsBefore(ctx context.Context, db sqlc.DBTX, userID string, t time.Time) (map[string]decimal.Decimal, error) {
	rows, err := sqlc.New(db).AccountBalancesBefore(ctx, sqlc.AccountBalancesBeforeParams{UserID: userID, Before: t})
	if err != nil {
		return nil, err
	}
	out := make(map[string]decimal.Decimal, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Balance
	}
	return out, nil
}

// Buckets returns the current TF of each of the user's buckets, by bucket ID:
// the sum of all its bucket lines.
func Buckets(ctx context.Context, db sqlc.DBTX, userID string) (map[string]decimal.Decimal, error) {
	rows, err := sqlc.New(db).BucketTargetFunds(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]decimal.Decimal, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Tf
	}
	return out, nil
}

// Figures is what happened to a bucket in one cycle, as shown on the
// Buckets screen ("used X of Y").
type Figures struct {
	// Start is TF when the cycle began: the bucket's lines in earlier cycles.
	Start decimal.Decimal
	// What was put into or taken out of the bucket in the cycle, by type,
	// signed: refills (REF), income (INC), opening funds (OPF), bucket
	// adjustments (BUA) and transfers between buckets (BAT).
	Refills, Income, Opening, Adjustments, Transfers decimal.Decimal
	// Budget is Start plus Refills, Income, Opening, Adjustments and
	// Transfers: everything except expenses and overflow.
	Budget decimal.Decimal
	// Used is what was spent: the cycle's EXP lines, net of corrections,
	// as a positive amount.
	Used decimal.Decimal
	// Overflow is what OVF removed in the cycle, as a positive amount:
	// Capped, when a refill pushed TF above BC (Keep funds), plus Swept, at
	// cycle end (without Keep funds).
	Overflow, Capped, Swept decimal.Decimal
	// Left is Budget − Used − Overflow: TF at the end of the cycle, or the
	// current TF while the cycle is active.
	Left decimal.Decimal
}

// Cycle returns each of the user's buckets' figures for a cycle, by bucket
// ID. Lines from later cycles are ignored, so a finished cycle's figures
// don't change. It returns ErrNotFound if the cycle isn't the user's.
func Cycle(ctx context.Context, db sqlc.DBTX, userID, cycleID string) (map[string]Figures, error) {
	q := sqlc.New(db)
	ok, err := q.CycleExists(ctx, sqlc.CycleExistsParams{ID: cycleID, UserID: userID})
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: cycle %s", ErrNotFound, cycleID)
	}
	rows, err := q.BucketCycleSums(ctx, sqlc.BucketCycleSumsParams{CycleID: cycleID, UserID: userID})
	if err != nil {
		return nil, err
	}
	out := make(map[string]Figures, len(rows))
	for _, r := range rows {
		f := Figures{
			Start:       r.Start,
			Refills:     r.Refills,
			Income:      r.Income,
			Opening:     r.Opening,
			Adjustments: r.Adjustments,
			Transfers:   r.Transfers,
			Used:        r.Expenses.Neg(),
			Overflow:    r.Overflow.Neg(),
			Capped:      r.Capped.Neg(),
		}
		f.Swept = f.Overflow.Sub(f.Capped)
		f.Budget = f.Start.Add(f.Refills).Add(f.Income).Add(f.Opening).Add(f.Adjustments).Add(f.Transfers)
		f.Left = f.Budget.Sub(f.Used).Sub(f.Overflow)
		out[r.ID] = f
	}
	return out, nil
}

// Flow is the money in and out of an account over a period (#90). Expenses
// and transfers out are positive amounts.
type Flow struct {
	AccountID    string
	Income       decimal.Decimal
	Expenses     decimal.Decimal
	TransfersIn  decimal.Decimal
	TransfersOut decimal.Decimal
}

// Flows returns the income, expenses and transfers of each of the user's
// accounts over [from, to), sorted by account ID. A transaction counts on
// its original's date, with its corrections (a reversed one adds up to 0);
// accounts without any are left out.
func Flows(ctx context.Context, db sqlc.DBTX, userID string, from, to time.Time) ([]Flow, error) {
	rows, err := sqlc.New(db).AccountFlows(ctx, sqlc.AccountFlowsParams{UserID: userID, FromAt: from, ToAt: to})
	if err != nil {
		return nil, err
	}
	out := make([]Flow, len(rows))
	for i, r := range rows {
		out[i] = Flow{
			AccountID:    r.AccountID,
			Income:       r.Income,
			Expenses:     r.Expenses,
			TransfersIn:  r.TransfersIn,
			TransfersOut: r.TransfersOut,
		}
	}
	return out, nil
}
