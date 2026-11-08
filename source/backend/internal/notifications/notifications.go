// Package notifications works out the user's reminders and to-dos (#57):
// things the app can't do for them, such as approving scheduled
// transactions, paying a bill at the bank or updating an investment
// account's balance.
//
// Notifications aren't stored. They're worked out from the user's data each
// time they're read, so one goes away by itself once its task is done. Only
// dismissals are stored, by key: a key names what the notification is about,
// so a dismissed one stays hidden until something new happens (another
// queued transaction, the next cycle). A dismissal whose notification no
// longer applies is forgotten, so an uncovered bucket shows again the next
// time it's uncovered.
package notifications

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
)

// ErrNotFound means no open notification has the key.
var ErrNotFound = errors.New("notification not found")

// Kind is what a notification is about.
type Kind string

const (
	// KindQueue is the scheduled transactions waiting for approval, as one.
	KindQueue Kind = "approval_queue"
	// KindBill is an expense or transfer a schedule records soon.
	KindBill Kind = "upcoming_bill"
	// KindBalance is an investment or fund account whose balance hasn't been
	// adjusted since the active cycle started.
	KindBalance Kind = "investment_balance"
	// KindBucket is a priority bucket whose CAF is below its TF.
	KindBucket Kind = "bucket_uncovered"
)

// keyPrefix is each kind's key prefix.
var keyPrefix = map[Kind]string{
	KindQueue: "queue:", KindBill: "bill:", KindBalance: "balance:", KindBucket: "bucket:",
}

// Severity orders notifications: alerts first.
type Severity string

const (
	Alert   Severity = "alert"
	Warning Severity = "warning"
	Info    Severity = "info"
)

var severityRank = map[Severity]int{Alert: 0, Warning: 1, Info: 2}

// DefaultDays is how many days ahead a bill shows by default.
const DefaultDays = 3

// Notification is an open reminder or to-do. Only the fields its kind uses
// are set.
type Notification struct {
	Key      string
	Kind     Kind
	Severity Severity
	// At is when it applies: the newest queued transaction's queue time, the
	// bill's time or the cycle's start. Zero for an uncovered bucket.
	At time.Time
	// Count and Overdue are how many wait for approval, and how many of them
	// are overdue.
	Count, Overdue int
	ScheduleID     string
	AccountID      string
	BucketID       string
	CycleID        string
	// Amount is the bill's amount, or what the bucket is missing.
	Amount   decimal.NullDecimal
	Currency string
}

// Settings is the user's notifications preference. Nil fields use the
// defaults: every kind on, bills DefaultDays ahead.
type Settings struct {
	ApprovalQueue     *bool `json:"approval_queue"`
	UpcomingBills     *bool `json:"upcoming_bills"`
	UpcomingDays      *int  `json:"upcoming_days"`
	InvestmentBalance *bool `json:"investment_balance"`
	BucketUncovered   *bool `json:"bucket_uncovered"`
}

// On reports whether a kind shows.
func (s Settings) On(k Kind) bool {
	v := map[Kind]*bool{
		KindQueue: s.ApprovalQueue, KindBill: s.UpcomingBills,
		KindBalance: s.InvestmentBalance, KindBucket: s.BucketUncovered,
	}[k]
	return v == nil || *v
}

// Days is how many days ahead a bill shows.
func (s Settings) Days() int {
	if s.UpcomingDays == nil || *s.UpcomingDays < 1 {
		return DefaultDays
	}
	return *s.UpcomingDays
}

// Schedules lists the user's schedules (a *schedules.Service).
type Schedules interface {
	List(ctx context.Context, userID string) ([]schedules.Schedule, error)
}

// Buckets lists the user's buckets with their TF (a *buckets.Service).
type Buckets interface {
	List(ctx context.Context, userID string) ([]buckets.Bucket, error)
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now       func() time.Time
	Schedules Schedules
	Buckets   Buckets
}

// Service works out notifications.
type Service struct {
	pool      *pgxpool.Pool
	now       func() time.Time
	schedules Schedules
	buckets   Buckets
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, now: opts.Now, schedules: opts.Schedules, buckets: opts.Buckets}
}

// List returns the user's open notifications: alerts first, then warnings,
// then the rest, each oldest first. It forgets the dismissals of ones that
// no longer apply.
func (s *Service) List(ctx context.Context, userID string) ([]Notification, error) {
	q := sqlc.New(s.pool)
	settings, err := s.settings(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	all, err := s.work(ctx, q, userID, settings)
	if err != nil {
		return nil, err
	}
	dismissed, err := q.ListDismissals(ctx, userID)
	if err != nil {
		return nil, err
	}
	open := make(map[string]bool, len(all))
	for _, n := range all {
		open[n.Key] = true
	}
	hidden := map[string]bool{}
	var stale []string
	for _, key := range dismissed {
		switch {
		case open[key]:
			hidden[key] = true
		case settings.On(kindOf(key)):
			// It no longer applies. Keys of kinds switched off are kept, as
			// they weren't worked out.
			stale = append(stale, key)
		}
	}
	if len(stale) > 0 {
		if err := q.ForgetDismissals(ctx, sqlc.ForgetDismissalsParams{UserID: userID, Keys: stale}); err != nil {
			return nil, err
		}
	}
	out := slices.DeleteFunc(all, func(n Notification) bool { return hidden[n.Key] })
	slices.SortStableFunc(out, func(a, b Notification) int {
		if c := cmp.Compare(severityRank[a.Severity], severityRank[b.Severity]); c != 0 {
			return c
		}
		// Ones without a time last.
		if a.At.IsZero() != b.At.IsZero() {
			if a.At.IsZero() {
				return 1
			}
			return -1
		}
		if c := a.At.Compare(b.At); c != 0 {
			return c
		}
		return strings.Compare(a.Key, b.Key)
	})
	return out, nil
}

// Dismiss hides the open notification with the key until it happens again.
// Dismissing one twice is fine.
func (s *Service) Dismiss(ctx context.Context, userID, key string) error {
	q := sqlc.New(s.pool)
	settings, err := s.settings(ctx, q, userID)
	if err != nil {
		return err
	}
	all, err := s.work(ctx, q, userID, settings)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(all, func(n Notification) bool { return n.Key == key }) {
		return fmt.Errorf("%w: %q", ErrNotFound, key)
	}
	return q.Dismiss(ctx, sqlc.DismissParams{UserID: userID, Key: key, DismissedAt: s.now()})
}

func (s *Service) settings(ctx context.Context, q *sqlc.Queries, userID string) (Settings, error) {
	raw, err := q.NotificationSettings(ctx, userID)
	if err != nil {
		return Settings{}, err
	}
	var out Settings
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &out); err != nil {
			return Settings{}, err
		}
	}
	return out, nil
}

// kindOf returns the kind a key belongs to, or "" for none.
func kindOf(key string) Kind {
	for k, p := range keyPrefix {
		if strings.HasPrefix(key, p) {
			return k
		}
	}
	return ""
}

// work works out the notifications of the kinds switched on, dismissed or
// not.
func (s *Service) work(ctx context.Context, q *sqlc.Queries, userID string, settings Settings) ([]Notification, error) {
	out := []Notification{}
	steps := []struct {
		kind Kind
		run  func(context.Context, *sqlc.Queries, string, Settings) ([]Notification, error)
	}{
		{KindQueue, s.queue}, {KindBill, s.bills}, {KindBalance, s.balances}, {KindBucket, s.uncovered},
	}
	for _, step := range steps {
		if !settings.On(step.kind) {
			continue
		}
		list, err := step.run(ctx, q, userID, settings)
		if err != nil {
			return nil, err
		}
		out = append(out, list...)
	}
	return out, nil
}

// queue is one notification for everything waiting for approval, keyed by
// the newest one: a new one shows it again after a dismissal.
func (s *Service) queue(ctx context.Context, q *sqlc.Queries, userID string, _ Settings) ([]Notification, error) {
	sum, err := q.QueueSummary(ctx, sqlc.QueueSummaryParams{UserID: userID, Now: s.now()})
	if err != nil || sum.Queued == 0 {
		return nil, err
	}
	n := Notification{
		Key: keyPrefix[KindQueue] + sum.NewestID, Kind: KindQueue, Severity: Warning, At: sum.NewestAt.UTC(),
		Count: int(sum.Queued), Overdue: int(sum.Overdue),
	}
	if n.Overdue > 0 {
		n.Severity = Alert
	}
	return []Notification{n}, nil
}

// maxBills is the most bills one schedule shows: a daily one over the
// longest window.
const maxBills = 15

// bills are the expenses and transfers schedules record within the days
// ahead. One that asks first is in the queue instead once it's queued.
func (s *Service) bills(ctx context.Context, q *sqlc.Queries, userID string, settings Settings) ([]Notification, error) {
	if s.schedules == nil {
		return nil, nil
	}
	list, err := s.schedules.List(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := q.AccountCurrencies(ctx, userID)
	if err != nil {
		return nil, err
	}
	currency := make(map[string]string, len(rows))
	for _, r := range rows {
		currency[r.ID] = r.Currency
	}
	until := s.now().Add(time.Duration(settings.Days()) * 24 * time.Hour)
	out := []Notification{}
	for _, sch := range list {
		t := sch.Transaction
		if sch.Paused || sch.NextAt.IsZero() || (t.Type != sqlc.TransactionTypeEXP && t.Type != sqlc.TransactionTypeTRF) {
			continue
		}
		rule, err := sch.Rule()
		if err != nil {
			continue
		}
		for _, at := range rule.Upcoming(sch.NextAt, maxBills) {
			if !at.Before(until) {
				break
			}
			out = append(out, Notification{
				Key:  keyPrefix[KindBill] + sch.ID + ":" + strconv.FormatInt(at.Unix(), 10),
				Kind: KindBill, Severity: Info, At: at.UTC(), ScheduleID: sch.ID, AccountID: t.AccountID,
				Amount: decimal.NullDecimal{Decimal: t.Amount, Valid: true}, Currency: currency[t.AccountID],
			})
		}
	}
	return out, nil
}

// balances are the investment and fund accounts with no balance adjustment
// since the active cycle started (made before it started), keyed by the
// cycle: the next cycle asks again.
func (s *Service) balances(ctx context.Context, q *sqlc.Queries, userID string, _ Settings) ([]Notification, error) {
	c, err := q.GetActiveCycle(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ids, err := q.AccountsToAdjust(ctx, sqlc.AccountsToAdjustParams{UserID: userID, Since: c.StartAt})
	if err != nil {
		return nil, err
	}
	out := make([]Notification, len(ids))
	for i, id := range ids {
		out[i] = Notification{
			Key:  keyPrefix[KindBalance] + c.ID + ":" + id,
			Kind: KindBalance, Severity: Info, At: c.StartAt.UTC(), AccountID: id, CycleID: c.ID,
		}
	}
	return out, nil
}

// uncovered are the priority buckets whose CAF is below their TF.
func (s *Service) uncovered(ctx context.Context, _ *sqlc.Queries, userID string, _ Settings) ([]Notification, error) {
	if s.buckets == nil {
		return nil, nil
	}
	list, err := s.buckets.List(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := []Notification{}
	for _, b := range list {
		if b.Deleted || !b.Priority || !b.TargetFunds.IsPositive() || !b.Caf.LessThan(b.TargetFunds) {
			continue
		}
		out = append(out, Notification{
			Key: keyPrefix[KindBucket] + b.ID, Kind: KindBucket, Severity: Alert, BucketID: b.ID,
			Amount: decimal.NullDecimal{Decimal: b.TargetFunds.Sub(b.Caf), Valid: true}, Currency: b.Currency,
		})
	}
	return out, nil
}
