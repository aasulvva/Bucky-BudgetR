package savings

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
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
//
// A sweep (#235) has no amount: it reserves what the account has
// unallocated above keep, at most one per mode and account:
//
//   - After the refills: once every bucket funded from the account but the
//     Fully manual ones is refilled in the cycle (RunBudget, after each
//     refill the routine makes). Undoing a refill on the account undoes it
//     (UndoSweeps).
//   - At cycle end: after the cycle-end routine's OVFs (RunBudget, from
//     OnEnd).

var (
	// ErrAlreadySaved means a manual entry has saved in this cycle already.
	ErrAlreadySaved = errors.New("the entry has saved in this cycle already")
	// ErrNoCycle means saving now needs an active cycle that holds now.
	ErrNoCycle = errors.New("saving needs an active cycle that holds the current time")
	// ErrSweepExists means the account has a sweep with this mode already.
	ErrSweepExists = errors.New("the account has a sweep with this mode already")
)

// IsSweep reports whether entries with this mode are sweeps (#235).
func IsSweep(w sqlc.SavingsBudgetWhen) bool {
	return w == sqlc.SavingsBudgetWhenAfterRefills || w == sqlc.SavingsBudgetWhenCycleEnd
}

// BudgetEntry is a fixed amount in the savings budget.
type BudgetEntry struct {
	ID        string
	AccountID string
	// TargetID is the target it saves for, "" for the distributor.
	TargetID string
	// Amount is a fixed amount's; 0 for a sweep.
	Amount decimal.Decimal
	// Keep is what a sweep leaves unallocated; 0 for a fixed amount.
	Keep decimal.Decimal
	When sqlc.SavingsBudgetWhen
	// Stopped means its target went away, so it doesn't run.
	Stopped bool
	// ThisCycle is its run in the active cycle, nil before it runs.
	ThisCycle  *BudgetRun
	CreatedAt  time.Time
	ModifiedAt time.Time
}

// IsSweep reports whether the entry is a sweep.
func (e BudgetEntry) IsSweep() bool { return IsSweep(e.When) }

// BudgetRun is an entry's run in a cycle.
type BudgetRun struct {
	// Wanted is the amount then (for a sweep, what was above keep); 0 when
	// it was set up mid-cycle to start in the next cycle.
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
	// Amount is a fixed amount's, zero for a sweep.
	Amount decimal.Decimal
	// Keep is a sweep's (nil is 0), nil for a fixed amount.
	Keep *decimal.Decimal
	When sqlc.SavingsBudgetWhen
	// ThisCycle is for an At cycle start entry, or an After the refills
	// sweep on an account refilled already, set up while a cycle runs: true
	// (or nil) reserves now for this cycle, false waits for the next.
	ThisCycle *bool
}

// BudgetChanges are the fields to change; nil leaves a field as it is. The
// source account stays.
type BudgetChanges struct {
	// TargetID "" is the distributor.
	TargetID *string
	// Amount is for a fixed amount, Keep for a sweep.
	Amount *decimal.Decimal
	Keep   *decimal.Decimal
	// When can't change a fixed amount into a sweep or back.
	When *sqlc.SavingsBudgetWhen
	// ThisCycle is as in NewBudget, for a change to At cycle start or After
	// the refills.
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
	if err := checkWhen(n.When); err != nil {
		return BudgetEntry{}, err
	}
	amount, keep, err := checkKind(n.When, &n.Amount, n.Keep, true)
	if err != nil {
		return BudgetEntry{}, err
	}
	var out BudgetEntry
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
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
					Amount: amount, RunWhen: n.When, Keep: keep,
				})
				return ids.Inserted(err)
			})
		if err != nil {
			return sweepExists(err)
		}
		if startsMidCycle(e.RunWhen) {
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
		if c.When != nil && IsSweep(*c.When) != IsSweep(cur.RunWhen) {
			return fmt.Errorf("%w: a fixed amount can't become a sweep, or a sweep a fixed amount", ErrInvalid)
		}
		if _, _, err := checkKind(cur.RunWhen, c.Amount, c.Keep, false); err != nil {
			return err
		}
		p := sqlc.UpdateBudgetEntryParams{
			ID: id, UserID: userID, TargetID: cur.TargetID, Amount: cur.Amount, RunWhen: cur.RunWhen, Keep: cur.Keep,
		}
		if c.TargetID != nil {
			if err := s.checkDestination(ctx, tx, userID, cur.AccountID, *c.TargetID); err != nil {
				return err
			}
			p.TargetID = text(*c.TargetID)
		}
		if c.Amount != nil {
			p.Amount = decimal.NewNullDecimal(*c.Amount)
		}
		if c.Keep != nil {
			p.Keep = decimal.NewNullDecimal(*c.Keep)
		}
		if c.When != nil {
			p.RunWhen = *c.When
		}
		e, err := q.UpdateBudgetEntry(ctx, p)
		if err != nil {
			return sweepExists(err)
		}
		if startsMidCycle(e.RunWhen) && cur.RunWhen != e.RunWhen {
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
// dated at, after the refills of the same moment: only those from accountID
// if it's set, and for On income triggered by incomeID. An After the refills
// sweep runs only once its account is refilled (AccountRefilled). It's
// called by the refill routine, in its transaction under the user's lock.
func (s *Service) RunBudget(ctx context.Context, tx pgx.Tx, userID string, c sqlc.Cycle, when sqlc.SavingsBudgetWhen, accountID string, at time.Time, incomeID string) error {
	q := sqlc.New(tx)
	entries, err := q.ListBudgetEntriesToRun(ctx, sqlc.ListBudgetEntriesToRunParams{
		UserID: userID, RunWhen: when, AccountID: text(accountID), CycleID: c.ID,
	})
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.RunWhen == sqlc.SavingsBudgetWhenAfterRefills {
			done, err := accountRefilled(ctx, q, userID, e.AccountID, c.ID)
			if err != nil {
				return err
			}
			if !done {
				continue
			}
		}
		if err := s.run(ctx, tx, userID, "", c.ID, e, at, incomeID); err != nil {
			return fmt.Errorf("savings budget entry %s: %w", e.ID, err)
		}
	}
	return nil
}

// UndoBudget undoes the runs an income triggered in the cycle: each SVR is
// reversed, the money following its way back (reverseHold), and the entries
// can run again.
func (s *Service) UndoBudget(ctx context.Context, tx pgx.Tx, userID, incomeID, cycleID string) error {
	runs, err := sqlc.New(tx).ListBudgetRunsByIncome(ctx, sqlc.ListBudgetRunsByIncomeParams{IncomeID: text(incomeID), CycleID: cycleID})
	if err != nil {
		return err
	}
	return s.undoRuns(ctx, tx, userID, runs)
}

// UndoSweeps undoes the After the refills sweeps on these accounts in the
// cycle, as UndoBudget does, when a refill on them is undone (#235): they
// run again once the accounts are refilled again.
func (s *Service) UndoSweeps(ctx context.Context, tx pgx.Tx, userID, cycleID string, accountIDs []string) error {
	runs, err := sqlc.New(tx).ListSweepRunsOfAccounts(ctx, sqlc.ListSweepRunsOfAccountsParams{
		UserID: userID, CycleID: cycleID, AccountIds: accountIDs,
	})
	if err != nil {
		return err
	}
	return s.undoRuns(ctx, tx, userID, runs)
}

func (s *Service) undoRuns(ctx context.Context, tx pgx.Tx, userID string, runs []sqlc.SavingsBudgetRun) error {
	q := sqlc.New(tx)
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
// less (a sweep: what's unallocated above keep), with an SVR at at, moves it
// on (AfterOverflow), and records the run.
func (s *Service) run(ctx context.Context, tx pgx.Tx, userID, createdBy, cycleID string, e sqlc.SavingsBudgetEntry, at time.Time, incomeID string) error {
	m, err := balance.AccountMoney(ctx, tx, userID)
	if err != nil {
		return err
	}
	free := decimal.Max(m[e.AccountID].Unallocated, decimal.Zero)
	wanted := e.Amount.Decimal
	if IsSweep(e.RunWhen) {
		wanted = decimal.Max(free.Sub(e.Keep.Decimal), decimal.Zero)
	}
	reserved := decimal.Min(wanted, free)
	var svr pgtype.Text
	lines, err := s.holdLines(ctx, tx, userID, e.AccountID, e.TargetID.String, reserved)
	if err != nil {
		return err
	}
	if len(lines) == 0 {
		reserved = decimal.Zero
		if IsSweep(e.RunWhen) {
			wanted = decimal.Zero
		}
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
		Wanted: wanted, Reserved: reserved, SvrID: svr, IncomeID: text(incomeID),
	})
}

// startMidCycle handles an At cycle start entry, or an After the refills
// sweep on an account refilled already, set up while a cycle holds now and
// it hasn't run in it: it reserves now (thisCycle true or nil), or records a
// skipped run so it waits for the next cycle. A sweep on an account still
// waiting for a refill runs after it as usual.
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
	if e.RunWhen == sqlc.SavingsBudgetWhenAfterRefills {
		done, err := accountRefilled(ctx, q, userID, e.AccountID, c.ID)
		if err != nil || !done {
			return err
		}
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
	case sqlc.SavingsBudgetWhenCycleStart, sqlc.SavingsBudgetWhenOnIncome, sqlc.SavingsBudgetWhenManual,
		sqlc.SavingsBudgetWhenAfterRefills, sqlc.SavingsBudgetWhenCycleEnd:
		return nil
	default:
		return fmt.Errorf("%w: unknown mode %q", ErrInvalid, w)
	}
}

// checkKind checks the amount and keep for an entry with mode w: a fixed
// amount has an amount above 0 and no keep, a sweep a keep of 0 or more
// (nil is 0 when creating) and no amount. Updating, a nil field stays; amount
// is the zero value for "none" when creating. It returns the columns.
func checkKind(w sqlc.SavingsBudgetWhen, amount, keep *decimal.Decimal, creating bool) (decimal.NullDecimal, decimal.NullDecimal, error) {
	if IsSweep(w) {
		if amount != nil && (!creating || !amount.IsZero()) {
			return decimal.NullDecimal{}, decimal.NullDecimal{}, fmt.Errorf("%w: a sweep has no amount, only one to keep", ErrInvalid)
		}
		k := decimal.Zero
		if keep != nil {
			k = *keep
			if err := money.Valid(k); err != nil {
				return decimal.NullDecimal{}, decimal.NullDecimal{}, fmt.Errorf("%w: keep: %w", ErrInvalid, err)
			}
			if k.IsNegative() {
				return decimal.NullDecimal{}, decimal.NullDecimal{}, fmt.Errorf("%w: the amount to keep can't be below 0", ErrInvalid)
			}
		}
		return decimal.NullDecimal{}, decimal.NewNullDecimal(k), nil
	}
	if keep != nil {
		return decimal.NullDecimal{}, decimal.NullDecimal{}, fmt.Errorf("%w: only a sweep has an amount to keep", ErrInvalid)
	}
	if amount == nil {
		if creating {
			return decimal.NullDecimal{}, decimal.NullDecimal{}, fmt.Errorf("%w: the amount must be above 0", ErrInvalid)
		}
		return decimal.NullDecimal{}, decimal.NullDecimal{}, nil
	}
	if err := checkAmount("amount", *amount); err != nil {
		return decimal.NullDecimal{}, decimal.NullDecimal{}, err
	}
	return decimal.NewNullDecimal(*amount), decimal.NullDecimal{}, nil
}

// accountRefilled reports whether the account's buckets, but the Fully
// manual ones, are all refilled in the cycle.
func accountRefilled(ctx context.Context, q *sqlc.Queries, userID, accountID, cycleID string) (bool, error) {
	done, err := q.AccountRefilled(ctx, sqlc.AccountRefilledParams{UserID: userID, AccountID: accountID, CycleID: cycleID})
	return done.Bool, err
}

// startsMidCycle reports whether an entry set up with mode w while a cycle
// runs can reserve in it at once (startMidCycle).
func startsMidCycle(w sqlc.SavingsBudgetWhen) bool {
	return w == sqlc.SavingsBudgetWhenCycleStart || w == sqlc.SavingsBudgetWhenAfterRefills
}

// sweepExists turns the one-sweep-per-mode index's violation into
// ErrSweepExists.
func sweepExists(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "savings_budget_entries_one_sweep_idx" {
		return ErrSweepExists
	}
	return err
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
			ID: r.ID, AccountID: r.AccountID, TargetID: r.TargetID.String, Amount: r.Amount.Decimal, Keep: r.Keep.Decimal, When: r.RunWhen,
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
