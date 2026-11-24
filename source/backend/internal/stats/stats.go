// Package stats sums spending, income and balances over a period cut into
// intervals (#121), for graphs, reports and widgets. The intervals are cut in
// the user's local time; the sums come from the ledger lines, never stored.
package stats

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// MaxIntervals is the most intervals a series can have.
const MaxIntervals = 1000

var (
	// ErrInvalid is a query that can't be answered as asked.
	ErrInvalid = errors.New("invalid stats query")
	// ErrTooMany is a period and resolution with more than MaxIntervals intervals.
	ErrTooMany = errors.New("too many intervals")
)

// Metric is what a series sums.
type Metric string

const (
	// Spending is expenses (EXP), as positive amounts.
	Spending Metric = "spending"
	// Income is incomes (INC).
	Income Metric = "income"
	// Balance is each account's balance at the end of each interval.
	Balance Metric = "balance"
)

// Resolution is how long an interval is.
type Resolution string

const (
	Hour  Resolution = "hour"
	Day   Resolution = "day"
	Week  Resolution = "week"
	Month Resolution = "month"
	Year  Resolution = "year"
	// Cycle is one interval per cycle that overlaps the period.
	Cycle Resolution = "cycle"
	// Total is one interval for the whole period.
	Total Resolution = "total"
)

// GroupBy is what a series is per.
type GroupBy string

const (
	// ByNone gives one series per currency.
	ByNone    GroupBy = "none"
	ByAccount GroupBy = "account"
	// ByBucket gives one series per bucket, and one per currency for the
	// part on no bucket.
	ByBucket GroupBy = "bucket"
	// ByCounterparty gives one series per effective counterparty, ignoring
	// case and spaces at the ends (#170), one for the part with no
	// counterparty, and one for transfers. Not for balances.
	ByCounterparty GroupBy = "counterparty"
)

// Query is what to sum. Empty filters match everything.
type Query struct {
	Metric     Metric
	From, To   time.Time
	Resolution Resolution
	// Location is the time zone the intervals are cut in (UTC if nil).
	Location *time.Location
	// WeekStart is the first day of a week.
	WeekStart time.Weekday
	GroupBy   GroupBy

	AccountIDs []string
	BucketIDs  []string
	Tags       []string
	// Counterparty matches part of the counterparty or the description.
	Counterparty string
	// Transfers counts transfers: money in as income, money out as spending.
	Transfers bool
}

// Interval is [Start, End).
type Interval struct {
	Start, End time.Time
}

// Line is one series: a value per interval, in one currency.
type Line struct {
	// AccountID is set when grouped by account.
	AccountID string
	// BucketID is set when grouped by bucket, except for the part on no
	// bucket (NoBucket).
	BucketID string
	NoBucket bool
	// Counterparty is set when grouped by counterparty: the spelling of the
	// series' newest transaction. NoCounterparty is the part without one,
	// and Transfers the transfers'.
	Counterparty   string
	NoCounterparty bool
	Transfers      bool
	Currency       string
	Values         []decimal.Decimal
}

// Result is the intervals and the series, sorted by currency, then account,
// bucket ID or counterparty, with the series on no bucket last in its
// currency, and per counterparty the one with none, then transfers, last.
type Result struct {
	Intervals []Interval
	Series    []Line
}

// Series sums the user's lines as q asks.
func Series(ctx context.Context, db sqlc.DBTX, userID string, q Query) (Result, error) {
	if err := check(&q); err != nil {
		return Result{}, err
	}
	queries := sqlc.New(db)
	intervals, err := cut(ctx, queries, userID, q)
	if err != nil {
		return Result{}, err
	}
	s := &sums{intervals: intervals, lines: map[key]*Line{}, labelAt: map[key]time.Time{}}
	if q.Metric == Balance {
		err = s.balances(ctx, queries, userID, q)
	} else {
		err = s.flows(ctx, queries, userID, q)
	}
	if err != nil {
		return Result{}, err
	}
	return Result{Intervals: intervals, Series: s.sorted()}, nil
}

func check(q *Query) error {
	if !q.From.Before(q.To) {
		return fmt.Errorf("%w: from must be before to", ErrInvalid)
	}
	if q.Location == nil {
		q.Location = time.UTC
	}
	if q.GroupBy == "" {
		q.GroupBy = ByNone
	}
	switch q.Metric {
	case Spending, Income:
	case Balance:
		if q.GroupBy == ByBucket || q.GroupBy == ByCounterparty || len(q.BucketIDs) > 0 || len(q.Tags) > 0 || q.Counterparty != "" || q.Transfers {
			return fmt.Errorf("%w: a balance can't be grouped or filtered by bucket, counterparty, tag or transfers", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: unknown metric %q", ErrInvalid, q.Metric)
	}
	switch q.GroupBy {
	case ByNone, ByAccount, ByBucket, ByCounterparty:
	default:
		return fmt.Errorf("%w: unknown grouping %q", ErrInvalid, q.GroupBy)
	}
	tags := make([]string, len(q.Tags))
	for i, t := range q.Tags {
		tags[i] = strings.ToLower(t)
	}
	q.Tags = tags
	return nil
}

// cut cuts [q.From, q.To) into intervals of q.Resolution in q.Location, the
// first and last cut at the period's ends.
func cut(ctx context.Context, queries *sqlc.Queries, userID string, q Query) ([]Interval, error) {
	switch q.Resolution {
	case Total:
		return []Interval{{q.From, q.To}}, nil
	case Cycle:
		rows, err := queries.StatsCycles(ctx, sqlc.StatsCyclesParams{UserID: userID, FromAt: q.From, ToAt: q.To})
		if err != nil {
			return nil, err
		}
		if len(rows) > MaxIntervals {
			return nil, ErrTooMany
		}
		out := make([]Interval, len(rows))
		for i, r := range rows {
			out[i] = Interval{maxTime(r.StartAt, q.From), minTime(r.EndAt, q.To)}
		}
		return out, nil
	case Hour, Day, Week, Month, Year:
		return Cut(q.From, q.To, q.Resolution, q.Location, q.WeekStart)
	}
	return nil, fmt.Errorf("%w: unknown resolution %q", ErrInvalid, q.Resolution)
}

// Cut cuts [from, to) into hours, days, weeks, months or years in loc, the
// first and last interval cut at from and to. Weeks start on weekStart.
func Cut(from, to time.Time, res Resolution, loc *time.Location, weekStart time.Weekday) ([]Interval, error) {
	start, next, err := steps(from.In(loc), res, weekStart)
	if err != nil {
		return nil, err
	}
	var out []Interval
	for edge := start; edge.Before(to); {
		end := next(edge)
		if len(out) == MaxIntervals {
			return nil, ErrTooMany
		}
		out = append(out, Interval{maxTime(edge, from), minTime(end, to)})
		edge = end
	}
	return out, nil
}

// steps gives the start of the interval holding t and how to get from one
// interval's start to the next's, in t's location.
func steps(t time.Time, res Resolution, weekStart time.Weekday) (time.Time, func(time.Time) time.Time, error) {
	loc := t.Location()
	y, m, _ := t.Date()
	day := func(t time.Time, days int) time.Time {
		y, m, d := t.Date()
		return time.Date(y, m, d+days, 0, 0, 0, 0, loc)
	}
	switch res {
	case Hour:
		// Hours are cut by the clock, so a 30-minute zone keeps its local
		// hours; on a change to or from summer time an hour stays an hour.
		start := t.Truncate(time.Minute).Add(-time.Duration(t.Minute()) * time.Minute)
		return start, func(t time.Time) time.Time { return t.Add(time.Hour) }, nil
	case Day:
		return day(t, 0), func(t time.Time) time.Time { return day(t, 1) }, nil
	case Week:
		back := (int(t.Weekday()) - int(weekStart) + 7) % 7
		return day(t, -back), func(t time.Time) time.Time { return day(t, 7) }, nil
	case Month:
		return time.Date(y, m, 1, 0, 0, 0, 0, loc), func(t time.Time) time.Time {
			y, m, _ := t.Date()
			return time.Date(y, m+1, 1, 0, 0, 0, 0, loc)
		}, nil
	case Year:
		return time.Date(y, 1, 1, 0, 0, 0, 0, loc), func(t time.Time) time.Time {
			return time.Date(t.Year()+1, 1, 1, 0, 0, 0, 0, loc)
		}, nil
	}
	return time.Time{}, nil, fmt.Errorf("%w: unknown resolution %q", ErrInvalid, res)
}

// key is what a series is per.
type key struct {
	currency, account, bucket string
	noBucket                  bool
	// counterparty is lower-cased and trimmed.
	counterparty              string
	noCounterparty, transfers bool
}

type sums struct {
	intervals []Interval
	lines     map[key]*Line
	// labelAt is when each counterparty series' label was last seen.
	labelAt map[key]time.Time
}

func (s *sums) line(k key) *Line {
	l, ok := s.lines[k]
	if !ok {
		values := make([]decimal.Decimal, len(s.intervals))
		for i := range values {
			values[i] = decimal.Zero
		}
		l = &Line{
			AccountID: k.account, BucketID: k.bucket, NoBucket: k.noBucket,
			NoCounterparty: k.noCounterparty, Transfers: k.transfers, Currency: k.currency, Values: values,
		}
		s.lines[k] = l
	}
	return l
}

// index is the interval holding t, or -1 (e.g. a day outside any cycle).
func (s *sums) index(t time.Time) int {
	i := sort.Search(len(s.intervals), func(i int) bool { return s.intervals[i].End.After(t) })
	if i < len(s.intervals) && !t.Before(s.intervals[i].Start) {
		return i
	}
	return -1
}

func (s *sums) add(k key, t time.Time, amount decimal.Decimal) {
	if i := s.index(t); i >= 0 {
		l := s.line(k)
		l.Values[i] = l.Values[i].Add(amount)
	}
}

// addFlow adds a family's amount to its series; per counterparty, the newest
// transaction's spelling labels it.
func (s *sums) addFlow(q Query, currency, account string, typ sqlc.TransactionType, counterparty string, t time.Time, amount decimal.Decimal) {
	k := s.flowKey(q, currency, account, typ, counterparty)
	if s.index(t) < 0 {
		return
	}
	s.add(k, t, amount)
	if k.counterparty != "" {
		if at, ok := s.labelAt[k]; !ok || !t.Before(at) {
			s.labelAt[k] = t
			s.lines[k].Counterparty = strings.TrimSpace(counterparty)
		}
	}
}

// isTransfer is whether a type's bank lines move money between the user's
// own accounts: a transfer, or savings moved into a bucket on another
// account (SVB, #231).
func isTransfer(typ sqlc.TransactionType) bool {
	return typ == sqlc.TransactionTypeTRF || typ == sqlc.TransactionTypeSVB
}

// flowKey is the series a family's amount goes to, grouped by none, account
// or counterparty.
func (s *sums) flowKey(q Query, currency, account string, typ sqlc.TransactionType, counterparty string) key {
	if q.GroupBy != ByCounterparty {
		return s.keyFor(q, currency, account)
	}
	switch name := strings.ToLower(strings.TrimSpace(counterparty)); {
	case isTransfer(typ):
		return key{currency: currency, transfers: true}
	case name == "":
		return key{currency: currency, noCounterparty: true}
	default:
		return key{currency: currency, counterparty: name}
	}
}

// flows sums spending or income.
func (s *sums) flows(ctx context.Context, queries *sqlc.Queries, userID string, q Query) error {
	// A bucket taking a purchase that waited for it (DBC, #264) is spending
	// in the bucket then; it has no bank lines.
	types := []string{string(sqlc.TransactionTypeEXP), string(sqlc.TransactionTypeDBC)}
	if q.Metric == Income {
		types = []string{string(sqlc.TransactionTypeINC)}
	}
	if q.Transfers {
		types = append(types, string(sqlc.TransactionTypeTRF), string(sqlc.TransactionTypeSVB))
	}
	// The value an amount adds: spending is money out, income money in. A
	// transfer counts only on the side that matches.
	value := func(typ sqlc.TransactionType, net decimal.Decimal) (decimal.Decimal, bool) {
		if isTransfer(typ) && (net.IsPositive() == (q.Metric == Spending)) {
			return decimal.Zero, false
		}
		if q.Metric == Spending {
			return net.Neg(), true
		}
		return net, true
	}
	accounts, buckets := nilIfEmpty(q.AccountIDs), nilIfEmpty(q.BucketIDs)
	tags, counterparty := nilIfEmpty(q.Tags), likeContains(q.Counterparty)
	byBucket := q.GroupBy == ByBucket || buckets != nil

	if err := s.empty(ctx, queries, userID, q); err != nil {
		return err
	}
	var bank []sqlc.StatsBankNetsRow
	if !byBucket || q.GroupBy == ByBucket && buckets == nil {
		var err error
		bank, err = queries.StatsBankNets(ctx, sqlc.StatsBankNetsParams{
			UserID: userID, Types: types, FromAt: q.From, ToAt: q.To,
			AccountIds: accounts, Tags: tags, Counterparty: counterparty,
		})
		if err != nil {
			return err
		}
	}
	if !byBucket {
		for _, r := range bank {
			if v, ok := value(r.TransactionType, r.Net); ok {
				s.addFlow(q, r.Currency, r.AccountID, r.TransactionType, r.Counterparty, r.TransactionAt, v)
			}
		}
		return nil
	}

	lines, err := queries.StatsBucketNets(ctx, sqlc.StatsBucketNetsParams{
		UserID: userID, Types: types, FromAt: q.From, ToAt: q.To,
		AccountIds: accounts, BucketIds: buckets, Tags: tags, Counterparty: counterparty,
	})
	if err != nil {
		return err
	}
	// What each family has on buckets per account, for the part on none.
	type famAccount struct{ family, account string }
	onBuckets := map[famAccount]decimal.Decimal{}
	for _, r := range lines {
		if v, ok := value(r.TransactionType, r.Net); ok {
			if q.GroupBy == ByBucket {
				s.add(key{currency: r.Currency, bucket: r.BucketID}, r.TransactionAt, v)
			} else {
				s.addFlow(q, r.Currency, r.AccountID, r.TransactionType, r.Counterparty, r.TransactionAt, v)
			}
		}
		fa := famAccount{r.ID, r.AccountID}
		onBuckets[fa] = onBuckets[fa].Add(r.Net)
	}
	// Grouped by bucket without a bucket filter: the rest of each family's
	// bank net is on no bucket, but for what waits for buckets (#264): that
	// counts when they take it.
	families := make([]string, len(bank))
	for i, r := range bank {
		families[i] = r.ID
	}
	parts, err := queries.StatsWaitingParts(ctx, families)
	if err != nil {
		return err
	}
	waiting := make(map[string]decimal.Decimal, len(parts))
	for _, p := range parts {
		waiting[p.ID] = p.Waiting
	}
	for _, r := range bank {
		rest := r.Net.Sub(onBuckets[famAccount{r.ID, r.AccountID}]).Add(waiting[r.ID])
		if rest.IsZero() {
			continue
		}
		if v, ok := value(r.TransactionType, rest); ok {
			s.add(key{currency: r.Currency, noBucket: true}, r.TransactionAt, v)
		}
	}
	return nil
}

// keyFor is the series an account's amount goes to, grouped by none or by
// account.
func (s *sums) keyFor(q Query, currency, account string) key {
	if q.GroupBy == ByAccount {
		return key{currency: currency, account: account}
	}
	return key{currency: currency}
}

// empty adds the series that show even without sums (all 0): one per
// account, bucket or currency of the accounts the query covers. Counterparties
// have no fixed set, so per counterparty there are none.
func (s *sums) empty(ctx context.Context, queries *sqlc.Queries, userID string, q Query) error {
	if q.GroupBy == ByCounterparty {
		return nil
	}
	accounts := nilIfEmpty(q.AccountIDs)
	if q.GroupBy == ByBucket || len(q.BucketIDs) > 0 {
		rows, err := queries.StatsBuckets(ctx, sqlc.StatsBucketsParams{UserID: userID, AccountIds: accounts, BucketIds: nilIfEmpty(q.BucketIDs)})
		if err != nil {
			return err
		}
		for _, r := range rows {
			switch q.GroupBy {
			case ByBucket:
				s.line(key{currency: r.Currency, bucket: r.ID})
			default:
				s.line(s.keyFor(q, r.Currency, r.AccountID))
			}
		}
		if q.GroupBy != ByBucket || len(q.BucketIDs) > 0 {
			return nil
		}
	}
	rows, err := queries.StatsAccounts(ctx, sqlc.StatsAccountsParams{UserID: userID, AccountIds: accounts})
	if err != nil {
		return err
	}
	for _, r := range rows {
		switch q.GroupBy {
		case ByBucket:
			s.line(key{currency: r.Currency, noBucket: true})
		default:
			s.line(s.keyFor(q, r.Currency, r.ID))
		}
	}
	return nil
}

// balances sums each account's lines up to the end of each interval.
func (s *sums) balances(ctx context.Context, queries *sqlc.Queries, userID string, q Query) error {
	rows, err := queries.StatsBalanceLines(ctx, sqlc.StatsBalanceLinesParams{
		UserID: userID, FromAt: q.From, ToAt: q.To, AccountIds: nilIfEmpty(q.AccountIDs),
	})
	if err != nil {
		return err
	}
	// Per account: its balance before the period, then what each interval adds.
	type account struct {
		currency string
		opening  decimal.Decimal
		changes  []decimal.Decimal
	}
	byID := map[string]*account{}
	var order []string
	for _, r := range rows {
		a, ok := byID[r.AccountID]
		if !ok {
			a = &account{currency: r.Currency, changes: make([]decimal.Decimal, len(s.intervals))}
			byID[r.AccountID] = a
			order = append(order, r.AccountID)
		}
		if !r.At.Valid {
			a.opening = a.opening.Add(r.Amount)
		} else if i := s.index(r.At.Time); i >= 0 {
			a.changes[i] = a.changes[i].Add(r.Amount)
		} else if s.beforeAll(r.At.Time) {
			// A cycle-resolution period can start before its first cycle.
			a.opening = a.opening.Add(r.Amount)
		} else if j := s.after(r.At.Time); j >= 0 {
			// Between cycles: it shows from the next interval on.
			a.changes[j] = a.changes[j].Add(r.Amount)
		}
	}
	for _, id := range order {
		a := byID[id]
		l := s.line(s.keyFor(q, a.currency, id))
		running := a.opening
		for i := range s.intervals {
			running = running.Add(a.changes[i])
			l.Values[i] = l.Values[i].Add(running)
		}
	}
	return nil
}

func (s *sums) beforeAll(t time.Time) bool {
	return len(s.intervals) == 0 || t.Before(s.intervals[0].Start)
}

// after is the first interval starting after t, or -1.
func (s *sums) after(t time.Time) int {
	for i, iv := range s.intervals {
		if iv.Start.After(t) {
			return i
		}
	}
	return -1
}

func (s *sums) sorted() []Line {
	out := make([]Line, 0, len(s.lines))
	for _, l := range s.lines {
		out = append(out, *l)
	}
	slices.SortFunc(out, func(a, b Line) int {
		return cmp.Or(
			cmp.Compare(a.Currency, b.Currency),
			compareBool(a.NoBucket, b.NoBucket),
			compareBool(a.Transfers, b.Transfers),
			compareBool(a.NoCounterparty, b.NoCounterparty),
			cmp.Compare(a.AccountID, b.AccountID),
			cmp.Compare(a.BucketID, b.BucketID),
			cmp.Compare(strings.ToLower(a.Counterparty), strings.ToLower(b.Counterparty)),
		)
	})
	return out
}

func compareBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case a:
		return 1
	}
	return -1
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func nilIfEmpty(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return s
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// likeContains is an ILIKE pattern matching text that contains s, or null.
func likeContains(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: "%" + likeEscaper.Replace(s) + "%", Valid: true}
}
