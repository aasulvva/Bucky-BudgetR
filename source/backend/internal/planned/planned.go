// Package planned keeps the user's planned purchases (#265, spec §5.7):
// something like a pre-order that's charged later, on a soft date.
//
// A plan counts in a cycle: the one that contains its expected date, or the
// active cycle once the expected date is before it (delayed past its cycle).
// There its bucket parts are set aside, as a figure only: no lines, so the
// buckets' money isn't touched. Recording its charge is an ordinary expense
// (transactions.New.PlannedID) that closes it.
package planned

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

var (
	// ErrNotFound means the plan doesn't exist or belongs to another user.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means the input breaks a rule. The message says which.
	ErrInvalid = errors.New("invalid")
	// ErrClosed means the plan was charged or cancelled, so it can't change.
	ErrClosed = transactions.ErrPlannedClosed
)

const (
	// MaxNameLength and MaxNoteLength bound the name (the expense's
	// counterparty) and the note (its description).
	MaxNameLength = 200
	MaxNoteLength = 500
	// OverdueAfter is how long after its expected time (the start of the
	// expected day) an open plan is overdue: once that day is over.
	OverdueAfter = 24 * time.Hour
)

// Settings are what the user sets.
type Settings struct {
	// Name is the name or store, the expense's counterparty.
	Name      string
	AccountID string
	Amount    decimal.Decimal
	// ExpectedAt is when it's expected to be charged: the start of the
	// expected day.
	ExpectedAt time.Time
	// Note is the expense's description.
	Note string
	// Buckets are its parts per bucket, as an expense's.
	Buckets []transactions.BucketAmount
}

// Plan is a saved planned purchase.
type Plan struct {
	ID string
	Settings
	Currency string
	Status   sqlc.PlannedPurchaseStatus
	// TransactionID is the expense that recorded its charge.
	TransactionID string
	// CycleID is the cycle it counts in, "" for none yet (see CycleOf).
	CycleID string
	// Overdue is set on an open plan once its expected day is over.
	Overdue   bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// Service keeps planned purchases.
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, now: opts.Now}
}

// List returns the user's open plans, or with closed the charged and
// cancelled ones, the soonest expected first.
func (s *Service) List(ctx context.Context, userID string, closed bool) ([]Plan, error) {
	statuses := []string{string(sqlc.PlannedPurchaseStatusOpen)}
	if closed {
		statuses = []string{string(sqlc.PlannedPurchaseStatusCharged), string(sqlc.PlannedPurchaseStatusCancelled)}
	}
	q := sqlc.New(s.pool)
	rows, err := q.ListPlannedPurchases(ctx, sqlc.ListPlannedPurchasesParams{UserID: userID, Statuses: statuses})
	if err != nil {
		return nil, err
	}
	return s.complete(ctx, q, userID, rows)
}

// Get returns one of the user's plans.
func (s *Service) Get(ctx context.Context, userID, id string) (Plan, error) {
	return s.get(ctx, sqlc.New(s.pool), userID, id)
}

// Create saves a plan.
func (s *Service) Create(ctx context.Context, userID string, in Settings) (Plan, error) {
	var out Plan
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The checks share-lock accounts and buckets, so the user's lock
		// comes first, as for every write (see ledger.LockUser).
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if err := check(ctx, tx, userID, &in); err != nil {
			return err
		}
		q := sqlc.New(tx)
		p := sqlc.CreatePlannedPurchaseParams{
			UserID: userID, Name: in.Name, AccountID: in.AccountID, Amount: in.Amount,
			ExpectedAt: in.ExpectedAt.UTC(), Note: in.Note,
		}
		var row sqlc.PlannedPurchase
		if _, err := ids.Insert(ctx, ids.PlannedPurchase, func() string { return ids.NewPlannedPurchase(userID) }, func(ctx context.Context, id string) (bool, error) {
			p.ID = id
			var err error
			row, err = q.CreatePlannedPurchase(ctx, p)
			return ids.Inserted(err)
		}); err != nil {
			return err
		}
		if err := addLines(ctx, q, userID, row.ID, in.Buckets); err != nil {
			return err
		}
		var err error
		out, err = s.get(ctx, q, userID, row.ID)
		return err
	})
	return out, err
}

// Update replaces an open plan's settings: moving its date is one.
func (s *Service) Update(ctx context.Context, userID, id string, in Settings) (Plan, error) {
	var out Plan
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		if err := openForUpdate(ctx, q, userID, id); err != nil {
			return err
		}
		if err := check(ctx, tx, userID, &in); err != nil {
			return err
		}
		if _, err := q.UpdatePlannedPurchase(ctx, sqlc.UpdatePlannedPurchaseParams{
			ID: id, UserID: userID, Name: in.Name, AccountID: in.AccountID, Amount: in.Amount,
			ExpectedAt: in.ExpectedAt.UTC(), Note: in.Note,
		}); err != nil {
			return err
		}
		if err := q.DeletePlannedBucketLines(ctx, sqlc.DeletePlannedBucketLinesParams{PlannedID: id, UserID: userID}); err != nil {
			return err
		}
		if err := addLines(ctx, q, userID, id, in.Buckets); err != nil {
			return err
		}
		var err error
		out, err = s.get(ctx, q, userID, id)
		return err
	})
	return out, err
}

// Cancel closes an open plan without a charge.
func (s *Service) Cancel(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		if err := openForUpdate(ctx, q, userID, id); err != nil {
			return err
		}
		return q.CancelPlannedPurchase(ctx, sqlc.CancelPlannedPurchaseParams{ID: id, UserID: userID})
	})
}

// SetAside returns what the user's open plans set aside in each bucket in a
// cycle (the ones that count in it), by bucket ID.
func (s *Service) SetAside(ctx context.Context, userID, cycleID string) (map[string]decimal.Decimal, error) {
	q := sqlc.New(s.pool)
	rows, err := q.ListPlannedPurchases(ctx, sqlc.ListPlannedPurchasesParams{
		UserID: userID, Statuses: []string{string(sqlc.PlannedPurchaseStatusOpen)},
	})
	if err != nil || len(rows) == 0 {
		return map[string]decimal.Decimal{}, err
	}
	cycles, err := q.ListCycles(ctx, userID)
	if err != nil {
		return nil, err
	}
	in := make([]string, 0, len(rows))
	for _, r := range rows {
		if CycleOf(r.ExpectedAt, cycles) == cycleID {
			in = append(in, r.ID)
		}
	}
	out := map[string]decimal.Decimal{}
	if len(in) == 0 {
		return out, nil
	}
	lines, err := q.ListPlannedBucketLines(ctx, in)
	if err != nil {
		return nil, err
	}
	for _, l := range lines {
		out[l.BucketID] = out[l.BucketID].Add(l.Amount)
	}
	return out, nil
}

// CycleOf returns the cycle a plan expected at counts in: the active cycle
// when at is before its start (the plan was delayed past its own cycle, or
// expected between cycles), else the cycle that contains at, or "" if none
// does yet. cycles are the user's.
func CycleOf(at time.Time, cycles []sqlc.Cycle) string {
	for _, c := range cycles {
		if c.State == sqlc.CycleStateActive && at.Before(c.StartAt) {
			return c.ID
		}
	}
	for _, c := range cycles {
		if !at.Before(c.StartAt) && at.Before(c.EndAt) {
			return c.ID
		}
	}
	return ""
}

// check cleans in and checks it as the expense it plans, for now.
func check(ctx context.Context, tx pgx.Tx, userID string, in *Settings) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Note = ledger.CleanDescription(in.Note)
	switch {
	case in.Name == "":
		return fmt.Errorf("%w: the name is required", ErrInvalid)
	case len([]rune(in.Name)) > MaxNameLength:
		return fmt.Errorf("%w: the name can be at most %d characters", ErrInvalid, MaxNameLength)
	case len([]rune(in.Note)) > MaxNoteLength:
		return fmt.Errorf("%w: the note can be at most %d characters", ErrInvalid, MaxNoteLength)
	case in.ExpectedAt.IsZero():
		return fmt.Errorf("%w: the expected date is required", ErrInvalid)
	}
	err := transactions.Check(ctx, tx, userID, transactions.New{
		Type: sqlc.TransactionTypeEXP, AccountID: in.AccountID, Amount: in.Amount,
		Counterparty: in.Name, Description: in.Note, Buckets: in.Buckets,
	})
	switch {
	case errors.Is(err, transactions.ErrInvalid), errors.Is(err, ledger.ErrInvalid):
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	case err != nil:
		return err
	}
	return nil
}

// openForUpdate locks the user's plan and checks that it's open.
func openForUpdate(ctx context.Context, q *sqlc.Queries, userID, id string) error {
	row, err := q.GetPlannedPurchaseForUpdate(ctx, sqlc.GetPlannedPurchaseForUpdateParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: planned purchase %s", ErrNotFound, id)
	}
	if err != nil {
		return err
	}
	if row.Status != sqlc.PlannedPurchaseStatusOpen {
		return ErrClosed
	}
	return nil
}

func addLines(ctx context.Context, q *sqlc.Queries, userID, id string, lines []transactions.BucketAmount) error {
	for i, l := range lines {
		if err := q.AddPlannedBucketLine(ctx, sqlc.AddPlannedBucketLineParams{
			PlannedID: id, BucketID: l.BucketID, UserID: userID, Amount: l.Amount, Position: int32(i),
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) get(ctx context.Context, q *sqlc.Queries, userID, id string) (Plan, error) {
	row, err := q.GetPlannedPurchase(ctx, sqlc.GetPlannedPurchaseParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Plan{}, fmt.Errorf("%w: planned purchase %s", ErrNotFound, id)
	}
	if err != nil {
		return Plan{}, err
	}
	list, err := s.complete(ctx, q, userID, []sqlc.PlannedPurchase{row})
	if err != nil {
		return Plan{}, err
	}
	return list[0], nil
}

// complete adds the rows' bucket parts, currencies and cycles.
func (s *Service) complete(ctx context.Context, q *sqlc.Queries, userID string, rows []sqlc.PlannedPurchase) ([]Plan, error) {
	out := make([]Plan, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	idList := make([]string, len(rows))
	for i, r := range rows {
		idList[i] = r.ID
	}
	lines, err := q.ListPlannedBucketLines(ctx, idList)
	if err != nil {
		return nil, err
	}
	byPlan := map[string][]transactions.BucketAmount{}
	for _, l := range lines {
		byPlan[l.PlannedID] = append(byPlan[l.PlannedID], transactions.BucketAmount{BucketID: l.BucketID, Amount: l.Amount})
	}
	currencies, err := q.AccountCurrencies(ctx, userID)
	if err != nil {
		return nil, err
	}
	currency := make(map[string]string, len(currencies))
	for _, c := range currencies {
		currency[c.ID] = strings.TrimSpace(c.Currency)
	}
	cycles, err := q.ListCycles(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	for i, r := range rows {
		open := r.Status == sqlc.PlannedPurchaseStatusOpen
		out[i] = Plan{
			ID: r.ID,
			Settings: Settings{
				Name: r.Name, AccountID: r.AccountID, Amount: r.Amount, ExpectedAt: r.ExpectedAt,
				Note: r.Note, Buckets: byPlan[r.ID],
			},
			Currency: currency[r.AccountID], Status: r.Status, TransactionID: r.TransactionID.String,
			Overdue: open && !now.Before(r.ExpectedAt.Add(OverdueAfter)), CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		}
		if open {
			out[i].CycleID = CycleOf(r.ExpectedAt, cycles)
		}
	}
	return out, nil
}
