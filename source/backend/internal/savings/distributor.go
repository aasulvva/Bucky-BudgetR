package savings

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// The savings distributor (#232, spec §8): one per user. It holds money per
// source account and splits it among the targets by their rules (Split), as
// one SVD per account.

// DefaultHoldMode is a new distributor's: it splits as money comes in.
const DefaultHoldMode = sqlc.SavingsHoldModeImmediate

// Distributor is the user's savings distributor with what it holds.
type Distributor struct {
	// ID is "" until the distributor has been used or set up.
	ID       string
	HoldMode sqlc.SavingsHoldMode
	// MinAmount is set with the minimum hold mode: it splits an account's
	// holdings once they reach it.
	MinAmount decimal.NullDecimal
	// Held is what it holds per source account.
	Held []Held
}

// Share is what a split gives a target. IntoBucket is when it goes straight
// into a bucket target funded from the account (a bucket line) rather than
// being held for it.
type Share struct {
	TargetID   string
	Amount     decimal.Decimal
	IntoBucket bool
}

// Plan is what splitting an amount would do: the shares, and what's left in
// the distributor.
type Plan struct {
	Shares []Share
	Left   decimal.Decimal
}

// Distributor returns the user's distributor, or the default settings if it
// hasn't been used yet.
func (s *Service) Distributor(ctx context.Context, userID string) (Distributor, error) {
	return readDistributor(ctx, s.pool, userID)
}

// UpdateDistributor sets the hold mode, with the minimum for the minimum
// mode. It doesn't move money: Distribute does.
func (s *Service) UpdateDistributor(ctx context.Context, userID string, mode sqlc.SavingsHoldMode, minAmount decimal.NullDecimal) (Distributor, error) {
	if !mode.Valid() {
		return Distributor{}, fmt.Errorf("%w: hold mode %q", ErrInvalid, mode)
	}
	if mode == sqlc.SavingsHoldModeMinimum {
		if !minAmount.Valid {
			return Distributor{}, fmt.Errorf("%w: the minimum hold mode needs an amount", ErrInvalid)
		}
		if err := checkAmount("minimum", minAmount.Decimal); err != nil {
			return Distributor{}, err
		}
	} else {
		minAmount = decimal.NullDecimal{}
	}
	var out Distributor
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := ensureDistributor(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := sqlc.New(tx).UpdateDistributor(ctx, sqlc.UpdateDistributorParams{
			UserID: userID, HoldMode: sqlc.NullSavingsHoldMode{SavingsHoldMode: mode, Valid: true}, MinAmount: minAmount,
		}); err != nil {
			return err
		}
		var err error
		out, err = readDistributor(ctx, tx, userID)
		return err
	})
	if err != nil {
		return Distributor{}, err
	}
	return out, nil
}

// AddToDistributor reserves amount of the account's unallocated money for the
// distributor (SVR), at most what's unallocated (*NotEnoughUnallocatedError).
// By its hold mode it's then split at once, or once the account's holdings
// reach the minimum. It returns the SVDs it recorded.
func (s *Service) AddToDistributor(ctx context.Context, userID, accountID string, amount decimal.Decimal) (Distributor, []string, error) {
	if err := checkAmount("amount", amount); err != nil {
		return Distributor{}, nil, err
	}
	var (
		out   Distributor
		split []string
	)
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		a, err := sqlc.New(tx).GetAccount(ctx, sqlc.GetAccountParams{ID: accountID, UserID: userID})
		if err != nil {
			return notFound(err, "account", accountID)
		}
		if a.AccountType == sqlc.AccountTypeCreditCard {
			return fmt.Errorf("%w: account %s", cards.ErrSource, accountID)
		}
		m, err := balance.AccountMoney(ctx, tx, userID)
		if err != nil {
			return err
		}
		if free := m[accountID].Unallocated; amount.GreaterThan(free) {
			return &NotEnoughUnallocatedError{Available: decimal.Max(free, decimal.Zero)}
		}
		d, err := ensureDistributor(ctx, tx, userID)
		if err != nil {
			return err
		}
		if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeSVR, At: s.now(),
			SavingsLines: []ledger.SavingsLine{{HolderID: d.ID, AccountID: accountID, Amount: amount}},
		}); err != nil {
			return err
		}
		if split, err = s.Incoming(ctx, tx, userID, accountID); err != nil {
			return err
		}
		out, err = readDistributor(ctx, tx, userID)
		return err
	})
	if err != nil {
		return Distributor{}, nil, err
	}
	return out, split, nil
}

// Incoming splits the distributor's holdings on the account if its hold mode
// says so: always in the immediate mode, once they reach the minimum in the
// minimum mode, never in the manual one. Run it in the transaction that
// gave the distributor money, after LockUser. It returns the SVD it
// recorded, if any.
func (s *Service) Incoming(ctx context.Context, tx pgx.Tx, userID, accountID string) ([]string, error) {
	d, err := sqlc.New(tx).GetDistributorForUpdate(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	switch d.HoldMode.SavingsHoldMode {
	case sqlc.SavingsHoldModeImmediate:
	case sqlc.SavingsHoldModeMinimum:
		held, err := s.heldNow(ctx, tx, d.ID, accountID)
		if err != nil {
			return nil, err
		}
		if held.LessThan(d.MinAmount.Decimal) {
			return nil, nil
		}
	default:
		return nil, nil
	}
	id, err := s.splitAccount(ctx, tx, userID, d.ID, accountID)
	if err != nil || id == "" {
		return nil, err
	}
	return []string{id}, nil
}

// Distribute splits what the distributor holds on the account now, or on
// every account for "", whatever its hold mode. It returns the SVDs it
// recorded: none when no target takes anything.
func (s *Service) Distribute(ctx context.Context, userID, accountID string) (Distributor, []string, error) {
	var (
		out   Distributor
		split []string
	)
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		d, err := q.GetDistributorForUpdate(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			out, err = readDistributor(ctx, tx, userID)
			return err
		}
		if err != nil {
			return err
		}
		held, err := q.SavingsHeld(ctx, userID)
		if err != nil {
			return err
		}
		for _, h := range held {
			if h.HolderID != d.ID || (accountID != "" && h.AccountID != accountID) || !h.Held.IsPositive() {
				continue
			}
			id, err := s.splitAccount(ctx, tx, userID, d.ID, h.AccountID)
			if err != nil {
				return err
			}
			if id != "" {
				split = append(split, id)
			}
		}
		out, err = readDistributor(ctx, tx, userID)
		return err
	})
	if err != nil {
		return Distributor{}, nil, err
	}
	return out, split, nil
}

// ClearDistributor gives amount of what the distributor holds on the account
// back to unallocated (SVC).
func (s *Service) ClearDistributor(ctx context.Context, userID, accountID string, amount decimal.Decimal) (Distributor, error) {
	if err := checkAmount("amount", amount); err != nil {
		return Distributor{}, err
	}
	var out Distributor
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		d, err := sqlc.New(tx).GetDistributorForUpdate(ctx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return &NotEnoughHeldError{Held: decimal.Zero}
		}
		if err != nil {
			return err
		}
		now := s.now()
		if err := checkHeld(ctx, tx, d.ID, accountID, amount, now, now); err != nil {
			return err
		}
		if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeSVC, At: now,
			SavingsLines: []ledger.SavingsLine{{HolderID: d.ID, AccountID: accountID, Amount: amount.Neg()}},
		}); err != nil {
			return err
		}
		out, err = readDistributor(ctx, tx, userID)
		return err
	})
	if err != nil {
		return Distributor{}, err
	}
	return out, nil
}

// Preview is what splitting amount from the account would do now, without
// recording anything.
func (s *Service) Preview(ctx context.Context, userID, accountID string, amount decimal.Decimal) (Plan, error) {
	if err := checkAmount("amount", amount); err != nil {
		return Plan{}, err
	}
	var out Plan
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		out, err = s.plan(ctx, tx, userID, accountID, amount)
		return err
	})
	if err != nil {
		return Plan{}, err
	}
	return out, nil
}

// splitAccount splits everything the distributor holds on the account as one
// SVD and returns its ID, or "" when no target takes anything.
func (s *Service) splitAccount(ctx context.Context, tx pgx.Tx, userID, distributorID, accountID string) (string, error) {
	held, err := s.heldNow(ctx, tx, distributorID, accountID)
	if err != nil || !held.IsPositive() {
		return "", err
	}
	p, err := s.plan(ctx, tx, userID, accountID, held)
	if err != nil {
		return "", err
	}
	placed := held.Sub(p.Left)
	if !placed.IsPositive() {
		return "", nil
	}
	targets, err := s.list(ctx, tx, userID)
	if err != nil {
		return "", err
	}
	e := ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: sqlc.TransactionTypeSVD, At: s.now(),
		SavingsLines: []ledger.SavingsLine{{HolderID: distributorID, AccountID: accountID, Amount: placed.Neg()}},
	}
	for _, sh := range p.Shares {
		if !sh.IntoBucket {
			e.SavingsLines = append(e.SavingsLines, ledger.SavingsLine{HolderID: sh.TargetID, AccountID: accountID, Amount: sh.Amount})
			continue
		}
		i := slices.IndexFunc(targets, func(t Target) bool { return t.ID == sh.TargetID })
		e.BucketLines = append(e.BucketLines, ledger.BucketLine{BucketID: targets[i].BucketID, Amount: sh.Amount})
	}
	t, err := s.ledger.Record(ctx, tx, e)
	if err != nil {
		return "", err
	}
	return t.Header.ID, nil
}

// plan splits amount from the account among the live targets in its
// currency (not the account itself, if it's a target) by their rules.
func (s *Service) plan(ctx context.Context, tx pgx.Tx, userID, accountID string, amount decimal.Decimal) (Plan, error) {
	q := sqlc.New(tx)
	account, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: accountID, UserID: userID})
	if err != nil {
		return Plan{}, notFound(err, "account", accountID)
	}
	targets, err := s.list(ctx, tx, userID)
	if err != nil {
		return Plan{}, err
	}
	rules, err := q.ListSavingsRules(ctx, userID)
	if err != nil {
		return Plan{}, err
	}
	// A bucket line needs an active cycle that contains now.
	cycleOK := false
	if c, err := q.GetActiveCycle(ctx, userID); err == nil {
		now := s.now()
		cycleOK = !now.Before(c.StartAt) && now.Before(c.EndAt)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Plan{}, err
	}

	// A locked BSU target is paused until it's set up (#214).
	locked, err := bsu.LockedAccounts(ctx, tx, userID)
	if err != nil {
		return Plan{}, err
	}
	var cands []Candidate
	intoBucket := map[string]bool{}
	for _, t := range targets {
		if t.Currency != account.Currency || t.AccountID == accountID || locked[t.AccountID] {
			continue
		}
		c, err := candidate(ctx, q, userID, t)
		if err != nil {
			return Plan{}, err
		}
		if t.BucketID != "" {
			intoBucket[t.ID] = cycleOK && t.BucketAccountID == accountID
		}
		for _, r := range rules {
			if r.TargetID == t.ID {
				c.Rules = append(c.Rules, ruleOf(r))
			}
		}
		cands = append(cands, c)
	}

	shares, left := Split(amount, cands)
	out := Plan{Left: left}
	for _, c := range cands {
		if a, ok := shares[c.ID]; ok {
			out.Shares = append(out.Shares, Share{TargetID: c.ID, Amount: a, IntoBucket: intoBucket[c.ID]})
		}
	}
	return out, nil
}

// heldNow is what the holder holds on the account.
func (s *Service) heldNow(ctx context.Context, tx pgx.Tx, holderID, accountID string) (decimal.Decimal, error) {
	return sqlc.New(tx).SavingsHeldAt(ctx, sqlc.SavingsHeldAtParams{HolderID: holderID, AccountID: accountID, At: s.now()})
}

// ensureDistributor returns the user's distributor, locked, creating it with
// the default hold mode if there's none. Run it after LockUser.
func ensureDistributor(ctx context.Context, tx pgx.Tx, userID string) (sqlc.SavingsHolder, error) {
	q := sqlc.New(tx)
	d, err := q.GetDistributorForUpdate(ctx, userID)
	if err == nil || !errors.Is(err, pgx.ErrNoRows) {
		return d, err
	}
	_, err = ids.Insert(ctx, ids.SavingsHolder, func() string { return ids.NewSavingsHolder(userID) },
		func(ctx context.Context, id string) (bool, error) {
			_, err := q.CreateDistributor(ctx, sqlc.CreateDistributorParams{
				ID: id, UserID: userID, HoldMode: sqlc.NullSavingsHoldMode{SavingsHoldMode: DefaultHoldMode, Valid: true},
			})
			return ids.Inserted(err)
		})
	if err != nil {
		return sqlc.SavingsHolder{}, err
	}
	return q.GetDistributorForUpdate(ctx, userID)
}

func readDistributor(ctx context.Context, db sqlc.DBTX, userID string) (Distributor, error) {
	q := sqlc.New(db)
	d, err := q.GetDistributor(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Distributor{HoldMode: DefaultHoldMode}, nil
	}
	if err != nil {
		return Distributor{}, err
	}
	out := Distributor{ID: d.ID, HoldMode: d.HoldMode.SavingsHoldMode, MinAmount: d.MinAmount}
	held, err := q.SavingsHeld(ctx, userID)
	if err != nil {
		return Distributor{}, err
	}
	m, err := balance.AccountMoney(ctx, db, userID)
	if err != nil {
		return Distributor{}, err
	}
	covered := coverage(held, m)
	for _, h := range held {
		if h.HolderID == d.ID {
			out.Held = append(out.Held, Held{AccountID: h.AccountID, Amount: h.Held, Covered: covered[h.HolderID+" "+h.AccountID]})
		}
	}
	return out, nil
}
