// Package schedules keeps the user's scheduled and recurring transactions
// (spec §10, #31) and records them when they come due.
//
// A schedule is a transaction to record, like one entered in New transaction,
// and a Rule for when. In auto mode the scheduler records each occurrence at
// its time; in approve mode it queues it for the user to approve. An
// occurrence that can't be recorded (no active cycle, outside it, an account
// or bucket that's gone) is queued too, with the reason.
package schedules

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

var (
	// ErrNotFound means the schedule doesn't exist or belongs to another user.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means the input breaks a rule. The message says which.
	ErrInvalid = errors.New("invalid")
)

const (
	// MaxNameLength is the longest name.
	MaxNameLength = 60
	// DefaultDueDays is how long an approval waits before it's overdue,
	// when not given.
	DefaultDueDays = 3
	// MaxDueDays and MaxEvery bound the due period and the repeat.
	MaxDueDays = 60
	MaxEvery   = 366
	// DefaultLimit and MaxLimit are the page sizes of Occurrences.
	DefaultLimit = 50
	MaxLimit     = 200
	// MaxUpcoming is the most occurrences Upcoming lists.
	MaxUpcoming = 50
)

// Settings are what a schedule records and when: what the user sets.
type Settings struct {
	Name string
	// Transaction is what to record; its At is ignored.
	Transaction transactions.New
	Mode        sqlc.ScheduleMode
	// DueDays is how many days after it's queued an approval is due.
	DueDays int
	// Start is the date of the first occurrence (a calendar date, at UTC
	// midnight), Minute its time of day in minutes after midnight, in
	// TimeZone. An empty TimeZone is the user's time zone preference, else UTC.
	Start     time.Time
	Minute    int
	TimeZone  string
	Frequency sqlc.ScheduleFrequency
	Every     int
	// EndCount (0: none) or EndDate (zero: none) ends it; see Rule.
	EndCount int
	EndDate  time.Time
	Paused   bool
}

// Schedule is a saved schedule.
type Schedule struct {
	ID string
	Settings
	// NextIndex is the number of the next occurrence (from 0, counted from
	// Start), and NextAt its time, or zero when the schedule has ended.
	NextIndex int
	NextAt    time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Rule returns the schedule's rule.
func (s Settings) Rule() (Rule, error) {
	loc, err := time.LoadLocation(s.TimeZone)
	if err != nil {
		return Rule{}, fmt.Errorf("%w: unknown time zone %q", ErrInvalid, s.TimeZone)
	}
	return Rule{Start: s.Start, Minute: s.Minute, Location: loc, Frequency: s.Frequency, Every: s.Every,
		EndCount: s.EndCount, EndDate: s.EndDate}, nil
}

// Occurrence is an occurrence that came due.
type Occurrence struct {
	ID          string
	ScheduleID  string
	ScheduledAt time.Time
	State       sqlc.OccurrenceState
	// Reason says why it was queued, Detail the error for ReasonInvalid.
	Reason sqlc.OccurrenceReason
	Detail string
	// QueuedAt and DueAt are set when it was queued.
	QueuedAt, DueAt time.Time
	// TransactionID is the transaction it recorded.
	TransactionID string
	ResolvedAt    time.Time
	// Overdue is set on a queued one past its due time.
	Overdue bool
}

// Filter narrows Occurrences. Zero fields match everything.
type Filter struct {
	State      sqlc.OccurrenceState
	ScheduleID string
	// Limit is the page size: DefaultLimit if 0, at most MaxLimit.
	Limit  int
	Cursor string
}

// Page is one page of Occurrences.
type Page struct {
	Items []Occurrence
	// Next is the cursor of the next page, or "" on the last page.
	Next string
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
	// Transactions records the occurrences.
	Transactions *transactions.Service
}

// Service keeps schedules and runs them.
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
	txs  *transactions.Service
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, now: opts.Now, txs: opts.Transactions}
}

// Create saves a schedule. Its first occurrence is the first at or after now:
// earlier ones aren't recorded.
func (s *Service) Create(ctx context.Context, userID string, in Settings) (Schedule, error) {
	return s.create(ctx, userID, in, false)
}

// CreateRecordingFirst saves a schedule like Create, but when its first
// occurrence (at Start) is at or before now, it's recorded now, dated then,
// and the schedule goes on from the next. This is a transaction entered in
// New transaction and set to repeat. If it can't be recorded, nothing is
// saved.
func (s *Service) CreateRecordingFirst(ctx context.Context, userID string, in Settings) (Schedule, error) {
	return s.create(ctx, userID, in, true)
}

func (s *Service) create(ctx context.Context, userID string, in Settings, recordFirst bool) (Schedule, error) {
	var out Schedule
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The checks share-lock accounts and buckets, so the user's lock
		// comes first, as for every write (see ledger.LockUser).
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		p, err := s.params(ctx, tx, userID, &in)
		if err != nil {
			return err
		}
		// The first occurrence, when it's recorded now.
		var first time.Time
		var firstTx string
		if recordFirst {
			rule, err := in.Rule()
			if err != nil {
				return err
			}
			if at, ok := rule.Occurrence(0); ok && !at.After(s.now()) {
				if s.txs == nil {
					return errors.New("no transactions service")
				}
				n := in.Transaction
				n.At = at
				t, err := s.txs.RecordIn(ctx, tx, userID, n)
				if err != nil {
					return err
				}
				first, firstTx = at, t.ID
				// It goes on from the first at or after now, after this one:
				// past ones between aren't recorded, as for Create.
				k, next, ok := rule.NextAt(s.now())
				if ok && k < 1 {
					k = 1
					next, ok = rule.Occurrence(1)
				}
				p.NextIndex, p.NextAt = int32(max(k, 1)), pgtype.Timestamptz{}
				if ok {
					p.NextAt = pgtype.Timestamptz{Time: next.UTC(), Valid: true}
				}
			}
		}
		if !p.NextAt.Valid && firstTx == "" {
			return fmt.Errorf("%w: the schedule has no occurrences from now on", ErrInvalid)
		}
		var row sqlc.Schedule
		if _, err := ids.Insert(ctx, ids.Schedule, func() string { return ids.NewSchedule(userID) }, func(ctx context.Context, id string) (bool, error) {
			p.ID = id
			var err error
			row, err = q.CreateSchedule(ctx, p)
			return ids.Inserted(err)
		}); err != nil {
			return err
		}
		if err := addLines(ctx, q, userID, row.ID, in.Transaction.Buckets); err != nil {
			return err
		}
		if firstTx != "" {
			now := s.now()
			o := sqlc.CreateOccurrenceParams{
				ScheduleID: row.ID, UserID: userID, ScheduledAt: first.UTC(), State: sqlc.OccurrenceStateApplied,
				TransactionID: pgtype.Text{String: firstTx, Valid: true}, ResolvedAt: pgtype.Timestamptz{Time: now, Valid: true},
			}
			if _, err := ids.Insert(ctx, ids.Occurrence, func() string { return ids.NewOccurrence(row.ID) }, func(ctx context.Context, id string) (bool, error) {
				o.ID = id
				_, err := q.CreateOccurrence(ctx, o)
				return ids.Inserted(err)
			}); err != nil {
				return err
			}
		}
		out, err = get(ctx, q, userID, row.ID)
		return err
	})
	return out, err
}

// Update replaces a schedule's settings. Its next occurrence is then the
// first at or after now, so resuming a paused schedule doesn't record the
// ones it missed.
func (s *Service) Update(ctx context.Context, userID, id string, in Settings) (Schedule, error) {
	var out Schedule
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		if _, err := q.GetScheduleForUpdate(ctx, sqlc.GetScheduleForUpdateParams{ID: id, UserID: userID}); err != nil {
			return notFound(err, id)
		}
		p, err := s.params(ctx, tx, userID, &in)
		if err != nil {
			return err
		}
		p.ID = id
		if _, err := q.UpdateSchedule(ctx, sqlc.UpdateScheduleParams(p)); err != nil {
			return err
		}
		if err := q.DeleteScheduleBucketLines(ctx, sqlc.DeleteScheduleBucketLinesParams{ScheduleID: id, UserID: userID}); err != nil {
			return err
		}
		if err := addLines(ctx, q, userID, id, in.Transaction.Buckets); err != nil {
			return err
		}
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

// Delete deletes a schedule and its occurrences. The transactions it
// recorded stay.
func (s *Service) Delete(ctx context.Context, userID, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		n, err := sqlc.New(tx).DeleteSchedule(ctx, sqlc.DeleteScheduleParams{ID: id, UserID: userID})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: schedule %s", ErrNotFound, id)
		}
		return nil
	})
}

// Get returns one of the user's schedules.
func (s *Service) Get(ctx context.Context, userID, id string) (Schedule, error) {
	return get(ctx, sqlc.New(s.pool), userID, id)
}

// List returns the user's schedules, the next due first, then the ended ones.
func (s *Service) List(ctx context.Context, userID string) ([]Schedule, error) {
	q := sqlc.New(s.pool)
	rows, err := q.ListSchedules(ctx, userID)
	if err != nil {
		return nil, err
	}
	return withLines(ctx, q, rows)
}

// Upcoming returns the times of a schedule's next n occurrences from now.
func (s *Service) Upcoming(ctx context.Context, userID, id string, n int) ([]time.Time, error) {
	if n < 1 || n > MaxUpcoming {
		return nil, fmt.Errorf("%w: the count must be 1 to %d", ErrInvalid, MaxUpcoming)
	}
	sch, err := s.Get(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if sch.NextAt.IsZero() {
		return []time.Time{}, nil
	}
	rule, err := sch.Rule()
	if err != nil {
		return nil, err
	}
	// From the next one, which can be a little before now until the
	// scheduler gets to it. A paused one resumes from the time it resumes.
	from := sch.NextAt
	if sch.Paused {
		from = s.now()
	}
	return rule.Upcoming(from, n), nil
}

// Occurrences returns a page of the user's occurrences, newest first.
func (s *Service) Occurrences(ctx context.Context, userID string, f Filter) (Page, error) {
	switch {
	case f.Limit == 0:
		f.Limit = DefaultLimit
	case f.Limit < 0 || f.Limit > MaxLimit:
		return Page{}, fmt.Errorf("%w: the limit must be 1 to %d", ErrInvalid, MaxLimit)
	}
	p := sqlc.ListOccurrencesParams{UserID: userID, RowLimit: int32(f.Limit + 1)} //nolint:gosec // at most MaxLimit + 1
	if f.State != "" {
		if !f.State.Valid() {
			return Page{}, fmt.Errorf("%w: state %q", ErrInvalid, f.State)
		}
		p.State = sqlc.NullOccurrenceState{OccurrenceState: f.State, Valid: true}
	}
	p.ScheduleID = pgtype.Text{String: f.ScheduleID, Valid: f.ScheduleID != ""}
	if f.Cursor != "" {
		at, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return Page{}, err
		}
		p.BeforeAt = pgtype.Timestamptz{Time: at, Valid: true}
		p.BeforeID = pgtype.Text{String: id, Valid: true}
	}
	rows, err := sqlc.New(s.pool).ListOccurrences(ctx, p)
	if err != nil {
		return Page{}, err
	}
	var page Page
	if len(rows) > f.Limit {
		rows = rows[:f.Limit]
		last := rows[len(rows)-1]
		page.Next = encodeCursor(last.ScheduledAt, last.ID)
	}
	page.Items = make([]Occurrence, len(rows))
	for i, r := range rows {
		page.Items[i] = s.fromOccurrence(r)
	}
	return page, nil
}

// Preview returns the times of the first n occurrences at or after now of a
// schedule with these settings, which needn't be saved. Only the repeat is
// checked: Start, Minute, TimeZone, Frequency, Every, EndCount and EndDate.
func (s *Service) Preview(ctx context.Context, userID string, in Settings, n int) ([]time.Time, error) {
	if n < 1 || n > MaxUpcoming {
		return nil, fmt.Errorf("%w: the count must be 1 to %d", ErrInvalid, MaxUpcoming)
	}
	rule, err := checkRule(ctx, sqlc.New(s.pool), userID, &in)
	if err != nil {
		return nil, err
	}
	return rule.Upcoming(s.now(), n), nil
}

// params checks in, fills its defaults and returns it as a row, with the next
// occurrence from now.
func (s *Service) params(ctx context.Context, tx pgx.Tx, userID string, in *Settings) (sqlc.CreateScheduleParams, error) {
	invalid := func(format string, args ...any) (sqlc.CreateScheduleParams, error) {
		return sqlc.CreateScheduleParams{}, fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
	}
	in.Name = strings.TrimSpace(in.Name)
	if len([]rune(in.Name)) > MaxNameLength {
		return invalid("the name can be at most %d characters", MaxNameLength)
	}
	if !in.Mode.Valid() {
		return invalid("mode %q", in.Mode)
	}
	if in.DueDays < 0 || in.DueDays > MaxDueDays {
		return invalid("the due period must be 0 to %d days", MaxDueDays)
	}
	rule, err := checkRule(ctx, sqlc.New(tx), userID, in)
	if err != nil {
		return sqlc.CreateScheduleParams{}, err
	}
	n := in.Transaction
	n.At = s.now()
	if err := transactions.Check(ctx, tx, userID, n); err != nil {
		return sqlc.CreateScheduleParams{}, err
	}

	p := sqlc.CreateScheduleParams{
		UserID: userID, Name: in.Name, TransactionType: n.Type, AccountID: n.AccountID,
		ToAccountID: pgtype.Text{String: n.ToAccountID, Valid: n.ToAccountID != ""}, Amount: n.Amount,
		Counterparty: n.Counterparty, Tags: n.Tags, Mode: in.Mode, DueDays: int32(in.DueDays),
		StartDate: in.Start, TimeOfDay: pgtype.Time{Microseconds: int64(in.Minute) * 60_000_000, Valid: true},
		TimeZone: in.TimeZone, Frequency: in.Frequency, Every: int32(in.Every), //nolint:gosec // checkRule keeps it within MaxEvery
		Paused: in.Paused,
	}
	if p.Tags == nil {
		p.Tags = []string{}
	}
	if n.TriggersRefill != nil {
		p.TriggersRefill = pgtype.Bool{Bool: *n.TriggersRefill, Valid: true}
	}
	if in.EndCount > 0 {
		p.EndCount = pgtype.Int4{Int32: int32(min(in.EndCount, maxIndex)), Valid: true}
	}
	if !in.EndDate.IsZero() {
		p.EndDate = pgtype.Date{Time: in.EndDate, Valid: true}
	}
	if k, at, ok := rule.NextAt(s.now()); ok {
		p.NextIndex = int32(k) //nolint:gosec // at most maxIndex
		p.NextAt = pgtype.Timestamptz{Time: at.UTC(), Valid: true}
	}
	return p, nil
}

// checkRule checks the repeat in in, fills its defaults (the user's time
// zone), and returns its rule.
func checkRule(ctx context.Context, q *sqlc.Queries, userID string, in *Settings) (Rule, error) {
	invalid := func(format string, args ...any) (Rule, error) {
		return Rule{}, fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
	}
	if !in.Frequency.Valid() {
		return invalid("frequency %q", in.Frequency)
	}
	if in.Frequency == sqlc.ScheduleFrequencyOnce {
		in.Every, in.EndCount, in.EndDate = 1, 0, time.Time{}
	}
	if in.Every < 1 || in.Every > MaxEvery {
		return invalid("the repeat must be every 1 to %d", MaxEvery)
	}
	if in.Minute < 0 || in.Minute >= 24*60 {
		return invalid("the time of day must be 00:00 to 23:59")
	}
	if in.Start.IsZero() {
		return invalid("no start date")
	}
	y, m, d := in.Start.Date()
	in.Start = time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	if in.EndCount < 0 {
		return invalid("the number of times must be at least 1")
	}
	if in.EndCount > 0 && !in.EndDate.IsZero() {
		return invalid("a schedule ends after a number of times or on a date, not both")
	}
	if !in.EndDate.IsZero() {
		y, m, d := in.EndDate.Date()
		if in.EndDate = time.Date(y, m, d, 0, 0, 0, 0, time.UTC); in.EndDate.Before(in.Start) {
			return invalid("the end date is before the start date")
		}
	}
	if in.TimeZone == "" {
		tz, err := q.UserTimeZone(ctx, userID)
		if err != nil {
			return Rule{}, err
		}
		in.TimeZone = tz
		if _, err := time.LoadLocation(tz); tz == "" || err != nil {
			in.TimeZone = "UTC"
		}
	}
	return in.Rule()
}

func addLines(ctx context.Context, q *sqlc.Queries, userID, id string, lines []transactions.BucketAmount) error {
	for i, l := range lines {
		if err := q.AddScheduleBucketLine(ctx, sqlc.AddScheduleBucketLineParams{
			ScheduleID: id, BucketID: l.BucketID, UserID: userID, Amount: l.Amount, Position: int32(i),
		}); err != nil {
			return err
		}
	}
	return nil
}

func get(ctx context.Context, q *sqlc.Queries, userID, id string) (Schedule, error) {
	row, err := q.GetSchedule(ctx, sqlc.GetScheduleParams{ID: id, UserID: userID})
	if err != nil {
		return Schedule{}, notFound(err, id)
	}
	list, err := withLines(ctx, q, []sqlc.Schedule{row})
	if err != nil {
		return Schedule{}, err
	}
	return list[0], nil
}

// withLines converts rows to Schedules with their bucket lines.
func withLines(ctx context.Context, q *sqlc.Queries, rows []sqlc.Schedule) ([]Schedule, error) {
	idList := make([]string, len(rows))
	for i, r := range rows {
		idList[i] = r.ID
	}
	lines, err := q.ListScheduleBucketLines(ctx, idList)
	if err != nil {
		return nil, err
	}
	out := make([]Schedule, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r, lines)
	}
	return out, nil
}

func fromRow(r sqlc.Schedule, lines []sqlc.ScheduleBucketLine) Schedule {
	s := Schedule{
		ID: r.ID, NextIndex: int(r.NextIndex), CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Settings: Settings{
			Name: r.Name, Mode: r.Mode, DueDays: int(r.DueDays), Start: r.StartDate,
			Minute: int(r.TimeOfDay.Microseconds / 60_000_000), TimeZone: r.TimeZone,
			Frequency: r.Frequency, Every: int(r.Every), EndCount: int(r.EndCount.Int32), Paused: r.Paused,
			Transaction: transactions.New{
				Type: r.TransactionType, AccountID: r.AccountID, ToAccountID: r.ToAccountID.String,
				Amount: r.Amount, Counterparty: r.Counterparty, Tags: r.Tags,
				Buckets: []transactions.BucketAmount{},
			},
		},
	}
	if r.EndDate.Valid {
		s.EndDate = r.EndDate.Time
	}
	if r.NextAt.Valid {
		s.NextAt = r.NextAt.Time
	}
	if r.TriggersRefill.Valid {
		v := r.TriggersRefill.Bool
		s.Transaction.TriggersRefill = &v
	}
	for _, l := range lines {
		if l.ScheduleID == r.ID {
			s.Transaction.Buckets = append(s.Transaction.Buckets, transactions.BucketAmount{BucketID: l.BucketID, Amount: l.Amount})
		}
	}
	return s
}

func (s *Service) fromOccurrence(r sqlc.ScheduleOccurrence) Occurrence {
	return Occurrence{
		ID: r.ID, ScheduleID: r.ScheduleID, ScheduledAt: r.ScheduledAt, State: r.State,
		Reason: r.Reason.OccurrenceReason, Detail: r.Detail,
		QueuedAt: r.QueuedAt.Time, DueAt: r.DueAt.Time, TransactionID: r.TransactionID.String, ResolvedAt: r.ResolvedAt.Time,
		Overdue: r.State == sqlc.OccurrenceStateQueued && r.DueAt.Valid && r.DueAt.Time.Before(s.now()),
	}
}

func notFound(err error, id string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: schedule %s", ErrNotFound, id)
	}
	return err
}

// A cursor is the time (in microseconds) and ID of a page's last row,
// base64-encoded so clients treat it as opaque.
func encodeCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(at.UnixMicro(), 10) + "." + id))
}

func decodeCursor(c string) (time.Time, string, error) {
	invalid := fmt.Errorf("%w: invalid cursor", ErrInvalid)
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return time.Time{}, "", invalid
	}
	micros, id, ok := strings.Cut(string(b), ".")
	us, err := strconv.ParseInt(micros, 10, 64)
	if !ok || err != nil || !ids.Occurrence.Valid(id) {
		return time.Time{}, "", invalid
	}
	return time.UnixMicro(us).UTC(), id, nil
}
