package savings

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// The savings budget's fixed amounts (#234, spec §8.6). An entry saves an
// amount per cycle from a source account, for a target or the distributor:
//
//   - At cycle start: after the Auto refills (RunBudget, from the refill
//     routine's OnStart).
//   - On income: after the account's On income refills, by the same income
//     (RunBudget, from OnIncome). Reversing or moving the income undoes it
//     (UndoBudget).
//   - Manually: when the user asks (SaveNow).
//
// Each runs at most once per cycle and reserves with an SVR, up to what the
// account has unallocated: the buckets are funded first. A target takes up
// to its goal, and the distributor the rest (holdLines). A run that reserves
// less than the amount shows as short (BudgetRun.Short), which the
// notifications report.

var (
	// ErrAlreadySaved means a manual entry has saved in this cycle already.
	ErrAlreadySaved = errors.New("the entry has saved in this cycle already")
	// ErrNoCycle means saving now needs an active cycle that holds now.
	ErrNoCycle = errors.New("saving needs an active cycle that holds the current time")
)

// BudgetEntry is a fixed amount in the savings budget.
type BudgetEntry struct {
	ID        string
	AccountID string
	// TargetID is the target it saves for, "" for the distributor.
	TargetID string
	Amount   decimal.Decimal
	When     sqlc.SavingsBudgetWhen
	// Stopped means its target went away, so it doesn't run.
	Stopped bool
	// ThisCycle is its run in the active cycle, nil before it runs.
	ThisCycle  *BudgetRun
	CreatedAt  time.Time
	ModifiedAt time.Time
}

// BudgetRun is an entry's run in a cycle.
type BudgetRun struct {
	// Wanted is the amount then; 0 when it was set up mid-cycle to start in
	// the next cycle.
	Wanted decimal.Decimal
	// Reserved is what the account's unallocated money allowed.
	Reserved decimal.Decimal
	// At is when it reserved, nil if it reserved nothing.
	At *time.Time
}

// Short is what the run fell short of the amount by.
func (r BudgetRun) Short() decimal.Decimal { return r.Wanted.Sub(r.Reserved) }

// NewBudget describes an entry to create.
type NewBudget struct {
	AccountID string
	// TargetID is "" for the distributor.
	TargetID string
	Amount   decimal.Decimal
	When     sqlc.SavingsBudgetWhen
	// ThisCycle is for an At cycle start entry set up while a cycle runs:
	// true (or nil) reserves now for this cycle, false waits for the next.
	ThisCycle *bool
}

// BudgetChanges are the fields to change; nil leaves a field as it is. The
// source account stays.
type BudgetChanges struct {
	// TargetID "" is the distributor.
	TargetID *string
	Amount   *decimal.Decimal
	When     *sqlc.SavingsBudgetWhen
	// ThisCycle is as in NewBudget, for a change to At cycle start.
	ThisCycle *bool
}

// ListBudget returns the user's entries, oldest first, with their runs in
// the active cycle.
func (s *Service) ListBudget(ctx context.Context, userID string) ([]BudgetEntry, error) {
	return listBudget(ctx, sqlc.New(s.pool), userID)
}

// CreateBudget creates an entry. One for At cycle start set up while a cycle
// runs reserves now, or waits for the next cycle (n.ThisCycle).
func (s *Service) CreateBudget(ctx context.Context, userID string, n NewBudget) (BudgetEntry, error) {
	if err := checkAmount("amount", n.Amount); err != nil {
		return BudgetEntry{}, err
	}
	if err := checkWhen(n.When); err != nil {
		return BudgetEntry{}, err
	}
	var out BudgetEntry
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if err := s.checkDestination(ctx, tx, userID, n.AccountID, n.TargetID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		var e sqlc.SavingsBudgetEntry
		id, err := ids.Insert(ctx, ids.SavingsBudgetEntry, func() string { return ids.NewSavingsBudgetEntry(userID) },
			func(ctx context.Context, id string) (bool, error) {
				var err error
				e, err = q.CreateBudgetEntry(ctx, sqlc.CreateBudgetEntryParams{
					ID: id, UserID: userID, AccountID: n.AccountID, TargetID: text(n.TargetID),
					Amount: n.Amount, RunWhen: n.When,
				})
				return ids.Inserted(err)
			})
		if err != nil {
			return err
		}
		if e.RunWhen == sqlc.SavingsBudgetWhenCycleStart {
			if err := s.startMidCycle(ctx, tx, userID, e, n.ThisCycle); err != nil {
				return err
			}
		}
		out, err = getBudget(ctx, q, userID, id)
		return err
	})
	if err != nil {
		return BudgetEntry{}, err
	}
	return out, nil
}

// UpdateBudget changes an entry. What it reserved stays; a change to At
// cycle start while a cycle runs is as in CreateBudget.
func (s *Service) UpdateBudget(ctx context.Context, userID, id string, c BudgetChanges) (BudgetEntry, error) {
	if c.Amount != nil {
		if err := checkAmount("amount", *c.Amount); err != nil {
			return BudgetEntry{}, err
		}
	}
	if c.When != nil {
		if err := checkWhen(*c.When); err != nil {
			return BudgetEntry{}, err
		}
	}
	var out BudgetEntry
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		cur, err := q.GetBudgetEntryForUpdate(ctx, sqlc.GetBudgetEntryForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, "savings budget entry", id)
		}
		p := sqlc.UpdateBudgetEntryParams{ID: id, UserID: userID, TargetID: cur.TargetID, Amount: cur.Amount, RunWhen: cur.RunWhen}
		if c.TargetID != nil {
			if err := s.checkDestination(ctx, tx, userID, cur.AccountID, *c.TargetID); err != nil {
				return err
			}
			p.TargetID = text(*c.TargetID)
		}
		if c.Amount != nil {
			p.Amount = *c.Amount
		}
		if c.When != nil {
			p.RunWhen = *c.When
		}
		e, err := q.UpdateBudgetEntry(ctx, p)
		if err != nil {
			return err
		}
		if e.RunWhen == sqlc.SavingsBudgetWhenCycleStart && cur.RunWhen != sqlc.SavingsBudgetWhenCycleStart {
			if err := s.startMidCycle(ctx, tx, userID, e, c.ThisCycle); err != nil {
				return err
			}
		}
		out, err = getBudget(ctx, q, userID, id)
		return err
	})
	if err != nil {
		return BudgetEntry{}, err
	}
	return out, nil
}

// DeleteBudget deletes an entry. What it reserved stays held.
func (s *Service) DeleteBudget(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		n, err := sqlc.New(tx).DeleteBudgetEntry(ctx, sqlc.DeleteBudgetEntryParams{ID: id, UserID: userID})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: savings budget entry %s", ErrNotFound, id)
		}
		return nil
	})
}

// SaveNow runs a Manually entry, once per cycle, in an active cycle that
// holds now.
func (s *Service) SaveNow(ctx context.Context, userID, id string) (BudgetEntry, error) {
	var out BudgetEntry
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		e, err := q.GetBudgetEntryForUpdate(ctx, sqlc.GetBudgetEntryForUpdateParams{ID: id, UserID: userID})
		if err != nil {
			return notFound(err, "savings budget entry", id)
		}
		if e.RunWhen != sqlc.SavingsBudgetWhenManual {
			return fmt.Errorf("%w: only a Manually entry is saved by hand", ErrInvalid)
		}
		if live, err := targetLive(ctx, q, userID, e); err != nil || !live {
			if err == nil {
				err = fmt.Errorf("%w: its savings target is gone", ErrInvalid)
			}
			return err
		}
		now := s.now()
		c, err := cycleAt(ctx, q, userID, now)
		if err != nil {
			return err
		}
		if c == nil {
			return ErrNoCycle
		}
		if _, err := q.GetBudgetRun(ctx, sqlc.GetBudgetRunParams{EntryID: id, CycleID: c.ID}); err == nil {
			return ErrAlreadySaved
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := s.run(ctx, tx, userID, userID, c.ID, e, now, ""); err != nil {
			return err
		}
		out, err = getBudget(ctx, q, userID, id)
		return err
	})
	if err != nil {
		return BudgetEntry{}, err
	}
	return out, nil
}

// RunBudget runs the entries with this mode that haven't run in cycle c,
// dated at, after the refills of the same moment: for On income only those
// from accountID, triggered by incomeID. It's called by the refill routine,
// in its transaction under the user's lock.
func (s *Service) RunBudget(ctx context.Context, tx pgx.Tx, userID string, c sqlc.Cycle, when sqlc.SavingsBudgetWhen, accountID string, at time.Time, incomeID string) error {
	q := sqlc.New(tx)
	entries, err := q.ListBudgetEntriesToRun(ctx, sqlc.ListBudgetEntriesToRunParams{
		UserID: userID, RunWhen: when, AccountID: text(accountID), CycleID: c.ID,
	})
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := s.run(ctx, tx, userID, "", c.ID, e, at, incomeID); err != nil {
			return fmt.Errorf("savings budget entry %s: %w", e.ID, err)
		}
	}
	return nil
}

// UndoBudget undoes the runs an income triggered in the cycle: each SVR is
// reversed as far as its money is still held (what was distributed or moved
// on stays where it went), and the entries can run again.
func (s *Service) UndoBudget(ctx context.Context, tx pgx.Tx, userID, incomeID, cycleID string) error {
	q := sqlc.New(tx)
	runs, err := q.ListBudgetRunsByIncome(ctx, sqlc.ListBudgetRunsByIncomeParams{IncomeID: text(incomeID), CycleID: cycleID})
	if err != nil {
		return err
	}
	for _, r := range runs {
		if r.SvrID.Valid {
			if err := s.reverseHold(ctx, tx, userID, r.SvrID.String); err != nil {
				return fmt.Errorf("undo savings budget entry %s: %w", r.EntryID, err)
			}
		}
		if err := q.DeleteBudgetRun(ctx, sqlc.DeleteBudgetRunParams{EntryID: r.EntryID, CycleID: r.CycleID}); err != nil {
			return err
		}
	}
	return nil
}

// run reserves the entry's amount, or what the account has unallocated if
// less, with an SVR at at, moves it on (AfterOverflow), and records the run.
func (s *Service) run(ctx context.Context, tx pgx.Tx, userID, createdBy, cycleID string, e sqlc.SavingsBudgetEntry, at time.Time, incomeID string) error {
	m, err := balance.AccountMoney(ctx, tx, userID)
	if err != nil {
		return err
	}
	reserved := decimal.Min(e.Amount, decimal.Max(m[e.AccountID].Unallocated, decimal.Zero))
	var svr pgtype.Text
	lines, err := s.holdLines(ctx, tx, userID, e.AccountID, e.TargetID.String, reserved)
	if err != nil {
		return err
	}
	if len(lines) == 0 {
		reserved = decimal.Zero
	} else {
		t, err := s.ledger.Record(ctx, tx, ledger.Entry{
			UserID: userID, CreatedBy: createdBy, Type: sqlc.TransactionTypeSVR, At: at, SavingsLines: lines,
		})
		if err != nil {
			return err
		}
		svr = text(t.Header.ID)
		if err := s.AfterOverflow(ctx, tx, userID, e.AccountID, t.Header.ID, at, lines); err != nil {
			return err
		}
	}
	return sqlc.New(tx).CreateBudgetRun(ctx, sqlc.CreateBudgetRunParams{
		EntryID: e.ID, CycleID: cycleID, UserID: userID, Trigger: e.RunWhen,
		Wanted: e.Amount, Reserved: reserved, SvrID: svr, IncomeID: text(incomeID),
	})
}

// startMidCycle handles an At cycle start entry set up while a cycle holds
// now and it hasn't run in it: it reserves now (thisCycle true or nil), or
// records a skipped run so it waits for the next cycle.
func (s *Service) startMidCycle(ctx context.Context, tx pgx.Tx, userID string, e sqlc.SavingsBudgetEntry, thisCycle *bool) error {
	q := sqlc.New(tx)
	now := s.now()
	c, err := cycleAt(ctx, q, userID, now)
	if err != nil || c == nil {
		return err
	}
	if _, err := q.GetBudgetRun(ctx, sqlc.GetBudgetRunParams{EntryID: e.ID, CycleID: c.ID}); err == nil {
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if thisCycle == nil || *thisCycle {
		return s.run(ctx, tx, userID, userID, c.ID, e, now, "")
	}
	return q.CreateBudgetRun(ctx, sqlc.CreateBudgetRunParams{
		EntryID: e.ID, CycleID: c.ID, UserID: userID, Trigger: e.RunWhen,
		Wanted: decimal.Zero, Reserved: decimal.Zero,
	})
}

// reverseHold reverses an SVR the savings budget recorded, dated at its
// time: what it moved on comes back first, then what's held is released,
// each as far as the money is still there (ReleaseOverflow).
func (s *Service) reverseHold(ctx context.Context, tx pgx.Tx, userID, id string) error {
	t, err := ledger.Get(ctx, tx, userID, id)
	if err != nil {
		return err
	}
	lines, err := s.ReleaseOverflow(ctx, tx, userID, t)
	if err != nil || len(lines) == 0 {
		return err
	}
	_, err = s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, Type: t.Header.TransactionType, Correction: sqlc.CorrectionTypeReversal,
		ParentID: id, At: t.Header.TransactionAt, SavingsLines: lines,
	})
	return err
}

// checkDestination checks an entry's source account and target: a live
// account, and a live target in its currency that isn't the account itself
// ("" is the distributor).
func (s *Service) checkDestination(ctx context.Context, tx pgx.Tx, userID, accountID, targetID string) error {
	if targetID == "" {
		_, err := sqlc.New(tx).GetAccount(ctx, sqlc.GetAccountParams{ID: accountID, UserID: userID})
		return notFound(err, "account", accountID)
	}
	t, err := lockTarget(ctx, tx, userID, targetID)
	if err != nil {
		return err
	}
	if err := s.checkSource(ctx, tx, userID, t, accountID); err != nil {
		return err
	}
	if t.account != nil && t.account.ID == accountID {
		return fmt.Errorf("%w: the money is in the target account already", ErrInvalid)
	}
	return nil
}

func checkWhen(w sqlc.SavingsBudgetWhen) error {
	switch w {
	case sqlc.SavingsBudgetWhenCycleStart, sqlc.SavingsBudgetWhenOnIncome, sqlc.SavingsBudgetWhenManual:
		return nil
	default:
		return fmt.Errorf("%w: unknown mode %q", ErrInvalid, w)
	}
}

// targetLive reports whether the entry's target is live (the distributor
// always is).
func targetLive(ctx context.Context, q *sqlc.Queries, userID string, e sqlc.SavingsBudgetEntry) (bool, error) {
	if !e.TargetID.Valid {
		return true, nil
	}
	_, err := q.GetSavingsHolderForUpdate(ctx, sqlc.GetSavingsHolderForUpdateParams{ID: e.TargetID.String, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// cycleAt returns the user's active cycle if it holds at, else nil.
func cycleAt(ctx context.Context, q *sqlc.Queries, userID string, at time.Time) (*sqlc.Cycle, error) {
	c, err := q.GetActiveCycle(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil //nolint:nilnil // no cycle isn't an error here
	}
	if err != nil {
		return nil, err
	}
	if at.Before(c.StartAt) || !at.Before(c.EndAt) {
		return nil, nil //nolint:nilnil // see above
	}
	return &c, nil
}

func listBudget(ctx context.Context, q *sqlc.Queries, userID string) ([]BudgetEntry, error) {
	rows, err := q.ListBudgetEntries(ctx, userID)
	if err != nil {
		return nil, err
	}
	runs := map[string]BudgetRun{}
	c, err := q.GetActiveCycle(ctx, userID)
	switch {
	case err == nil:
		rs, err := q.ListBudgetRuns(ctx, sqlc.ListBudgetRunsParams{UserID: userID, CycleID: c.ID})
		if err != nil {
			return nil, err
		}
		for _, r := range rs {
			run := BudgetRun{Wanted: r.Wanted, Reserved: r.Reserved}
			if r.SvrAt.Valid {
				at := r.SvrAt.Time
				run.At = &at
			}
			runs[r.EntryID] = run
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return nil, err
	}
	out := make([]BudgetEntry, len(rows))
	for i, r := range rows {
		out[i] = BudgetEntry{
			ID: r.ID, AccountID: r.AccountID, TargetID: r.TargetID.String, Amount: r.Amount, When: r.RunWhen,
			Stopped: r.Stopped, CreatedAt: r.CreatedAt, ModifiedAt: r.ModifiedAt,
		}
		if run, ok := runs[r.ID]; ok {
			out[i].ThisCycle = &run
		}
	}
	return out, nil
}

func getBudget(ctx context.Context, q *sqlc.Queries, userID, id string) (BudgetEntry, error) {
	list, err := listBudget(ctx, q, userID)
	if err != nil {
		return BudgetEntry{}, err
	}
	for _, e := range list {
		if e.ID == id {
			return e, nil
		}
	}
	return BudgetEntry{}, fmt.Errorf("%w: savings budget entry %s", ErrNotFound, id)
}

func text(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }
