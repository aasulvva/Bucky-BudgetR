package stats

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// FlowsQuery is what the In/out/balance report module asks for (#126):
// [From, To) cut into months, cycles or one interval, for the buckets and
// accounts that match. Empty filters match everything.
type FlowsQuery struct {
	From, To   time.Time
	Resolution Resolution
	// Location is the time zone the intervals are cut in (UTC if nil).
	Location   *time.Location
	AccountIDs []string
	BucketIDs  []string
}

// BucketValues is a bucket's money in and out over an interval, all
// positive, with its TF at the start and end: Start + In − Out = End.
type BucketValues struct {
	Start                         decimal.Decimal
	Refills, Income, Opening      decimal.Decimal
	AdjustmentsIn, AdjustmentsOut decimal.Decimal
	TransfersIn, TransfersOut     decimal.Decimal
	Spent, Overflow               decimal.Decimal
	In, Out, End                  decimal.Decimal
}

// AccountValues is an account's income, expenses and transfers over an
// interval, all positive, with its balance at the start and end (#187).
// Other is the net of the rest (opening balances, balance adjustments), so
// Start + Income − Expenses + TransfersIn − TransfersOut + Other = End.
type AccountValues struct {
	Start                     decimal.Decimal
	Income, Expenses          decimal.Decimal
	TransfersIn, TransfersOut decimal.Decimal
	Other, End                decimal.Decimal
}

// BucketFlow is a bucket's values per interval. OpenedAt is when its
// opening funds (OPF) are dated, when that's in one of the intervals: that
// interval starts with them rather than counting them in (#187), and the
// intervals before are 0, as nothing is known about them.
type BucketFlow struct {
	BucketID, AccountID, Currency string
	OpenedAt                      *time.Time
	Values                        []BucketValues
}

// AccountFlow is an account's values per interval. OpenedAt is when its
// opening balance (OPB) is dated, when that's in one of the intervals: that
// interval starts with it rather than counting it in Other (#187).
type AccountFlow struct {
	AccountID, Currency string
	OpenedAt            *time.Time
	Values              []AccountValues
}

// opening is a row's opening transaction, when it's in an interval.
type opening struct {
	id       string
	at       time.Time
	interval int
}

// openings gives each row's first opening transaction that's dated in one
// of the intervals.
func openings(s *sums, q FlowsQuery, rows func(yield func(row, id string, at time.Time))) map[string]opening {
	out := map[string]opening{}
	rows(func(row, id string, at time.Time) {
		if _, ok := out[row]; ok || at.Before(q.From) {
			return
		}
		out[row] = opening{id: id, at: at, interval: s.index(at)}
	})
	for row, o := range out {
		if o.interval < 0 {
			delete(out, row)
		}
	}
	return out
}

// FlowsResult is the intervals, and the buckets' and accounts' flows, sorted
// by ID.
type FlowsResult struct {
	Intervals []Interval
	Buckets   []BucketFlow
	Accounts  []AccountFlow
}

// accountTypes are every type with bank lines, so the balances add up.
var accountTypes = []string{
	string(sqlc.TransactionTypeOPB), string(sqlc.TransactionTypeBLA), string(sqlc.TransactionTypeINC),
	string(sqlc.TransactionTypeEXP), string(sqlc.TransactionTypeTRF), string(sqlc.TransactionTypeINP),
	string(sqlc.TransactionTypeOPF), string(sqlc.TransactionTypeREF), string(sqlc.TransactionTypeBUA),
	string(sqlc.TransactionTypeBAT), string(sqlc.TransactionTypeOVF), string(sqlc.TransactionTypeSVB),
}

// bucketTypes are the types with bucket lines that move a bucket's TF.
var bucketTypes = []string{
	string(sqlc.TransactionTypeREF), string(sqlc.TransactionTypeINC), string(sqlc.TransactionTypeOPF),
	string(sqlc.TransactionTypeBUA), string(sqlc.TransactionTypeBAT),
	string(sqlc.TransactionTypeEXP), string(sqlc.TransactionTypeOVF), string(sqlc.TransactionTypeSVB),
	string(sqlc.TransactionTypeSVD), string(sqlc.TransactionTypeDBC),
}

// Flows sums each bucket's and account's money in and out per interval. A
// transaction family counts on its original's date, as Series counts it.
func Flows(ctx context.Context, db sqlc.DBTX, userID string, q FlowsQuery) (FlowsResult, error) {
	if !q.From.Before(q.To) {
		return FlowsResult{}, fmt.Errorf("%w: from must be before to", ErrInvalid)
	}
	switch q.Resolution {
	case Month, Cycle, Total:
	default:
		return FlowsResult{}, fmt.Errorf("%w: flows are per month, cycle or the whole period, not %q", ErrInvalid, q.Resolution)
	}
	if q.Location == nil {
		q.Location = time.UTC
	}
	queries := sqlc.New(db)
	intervals, err := cut(ctx, queries, userID, Query{From: q.From, To: q.To, Resolution: q.Resolution, Location: q.Location})
	if err != nil {
		return FlowsResult{}, err
	}
	s := &sums{intervals: intervals}
	accounts, buckets := nilIfEmpty(q.AccountIDs), nilIfEmpty(q.BucketIDs)

	bucketsOut, err := bucketFlows(ctx, queries, userID, q, s, accounts, buckets)
	if err != nil {
		return FlowsResult{}, err
	}
	accountsOut, err := accountFlows(ctx, queries, userID, q, s, accounts)
	if err != nil {
		return FlowsResult{}, err
	}
	return FlowsResult{Intervals: intervals, Buckets: bucketsOut, Accounts: accountsOut}, nil
}

func bucketFlows(ctx context.Context, queries *sqlc.Queries, userID string, q FlowsQuery, s *sums, accounts, buckets []string) ([]BucketFlow, error) {
	list, err := queries.StatsBuckets(ctx, sqlc.StatsBucketsParams{UserID: userID, AccountIds: accounts, BucketIds: buckets})
	if err != nil {
		return nil, err
	}
	starts, err := queries.StatsBucketStarts(ctx, sqlc.StatsBucketStartsParams{UserID: userID, FromAt: q.From, AccountIds: accounts, BucketIds: buckets})
	if err != nil {
		return nil, err
	}
	nets, err := queries.StatsBucketNets(ctx, sqlc.StatsBucketNetsParams{
		UserID: userID, Types: bucketTypes, FromAt: q.From, ToAt: q.To, AccountIds: accounts, BucketIds: buckets,
	})
	if err != nil {
		return nil, err
	}
	opfs, err := queries.StatsBucketOpenings(ctx, sqlc.StatsBucketOpeningsParams{UserID: userID, AccountIds: accounts, BucketIds: buckets})
	if err != nil {
		return nil, err
	}
	opened := openings(s, q, func(yield func(row, id string, at time.Time)) {
		for _, r := range opfs {
			yield(r.BucketID, r.TransactionID, r.TransactionAt)
		}
	})
	// What each bucket's opening funds start its opening interval with.
	openingStart := map[string]decimal.Decimal{}
	out := make([]BucketFlow, len(list))
	at := make(map[string]int, len(list))
	for i, b := range list {
		out[i] = BucketFlow{BucketID: b.ID, AccountID: b.AccountID, Currency: b.Currency, Values: make([]BucketValues, len(s.intervals))}
		at[b.ID] = i
	}
	for _, r := range nets {
		i, ok := at[r.BucketID]
		j := s.index(r.TransactionAt)
		if !ok || j < 0 {
			continue
		}
		v := &out[i].Values[j]
		if o, ok := opened[r.BucketID]; ok && o.id == r.ID {
			openingStart[r.BucketID] = openingStart[r.BucketID].Add(r.Net)
			continue
		}
		switch net := r.Net; r.TransactionType {
		case sqlc.TransactionTypeREF:
			v.Refills = v.Refills.Add(net)
		case sqlc.TransactionTypeINC:
			v.Income = v.Income.Add(net)
		case sqlc.TransactionTypeOPF:
			v.Opening = v.Opening.Add(net)
		case sqlc.TransactionTypeEXP, sqlc.TransactionTypeDBC:
			v.Spent = v.Spent.Sub(net)
		case sqlc.TransactionTypeOVF:
			v.Overflow = v.Overflow.Sub(net)
		case sqlc.TransactionTypeBUA, sqlc.TransactionTypeSVB, sqlc.TransactionTypeSVD:
			// Savings into a bucket (#231, #232) count as an adjustment in.
			if net.IsPositive() {
				v.AdjustmentsIn = v.AdjustmentsIn.Add(net)
			} else {
				v.AdjustmentsOut = v.AdjustmentsOut.Sub(net)
			}
		case sqlc.TransactionTypeBAT:
			if net.IsPositive() {
				v.TransfersIn = v.TransfersIn.Add(net)
			} else {
				v.TransfersOut = v.TransfersOut.Sub(net)
			}
		}
	}
	start := make(map[string]decimal.Decimal, len(starts))
	for _, r := range starts {
		start[r.BucketID] = r.Start
	}
	// The TF runs on from one interval's end to the next's start. Bucket
	// lines are always inside a cycle, so cycle intervals leave none out.
	for i := range out {
		id := out[i].BucketID
		tf := start[id]
		o, isOpened := opened[id]
		if isOpened {
			out[i].OpenedAt = &o.at
		}
		for j := range out[i].Values {
			v := &out[i].Values[j]
			v.Start = tf
			if isOpened && j == o.interval {
				v.Start = v.Start.Add(openingStart[id])
			}
			v.In = v.Refills.Add(v.Income).Add(v.Opening).Add(v.AdjustmentsIn).Add(v.TransfersIn)
			v.Out = v.Spent.Add(v.Overflow).Add(v.AdjustmentsOut).Add(v.TransfersOut)
			v.End = v.Start.Add(v.In).Sub(v.Out)
			tf = v.End
		}
	}
	return out, nil
}

func accountFlows(ctx context.Context, queries *sqlc.Queries, userID string, q FlowsQuery, s *sums, accounts []string) ([]AccountFlow, error) {
	list, err := queries.StatsAccounts(ctx, sqlc.StatsAccountsParams{UserID: userID, AccountIds: accounts})
	if err != nil {
		return nil, err
	}
	starts, err := queries.StatsAccountStarts(ctx, sqlc.StatsAccountStartsParams{UserID: userID, FromAt: q.From, AccountIds: accounts})
	if err != nil {
		return nil, err
	}
	nets, err := queries.StatsBankNets(ctx, sqlc.StatsBankNetsParams{
		UserID: userID, FromAt: q.From, ToAt: q.To, AccountIds: accounts, Types: accountTypes,
	})
	if err != nil {
		return nil, err
	}
	opbs, err := queries.StatsAccountOpenings(ctx, sqlc.StatsAccountOpeningsParams{UserID: userID, AccountIds: accounts})
	if err != nil {
		return nil, err
	}
	opened := openings(s, q, func(yield func(row, id string, at time.Time)) {
		for _, r := range opbs {
			yield(r.AccountID, r.TransactionID, r.TransactionAt)
		}
	})
	// What each account's opening balance starts its opening interval with.
	openingStart := map[string]decimal.Decimal{}
	out := make([]AccountFlow, len(list))
	at := make(map[string]int, len(list))
	// Lines between two cycles count in no interval, but move the next
	// one's start balance.
	gaps := make([][]decimal.Decimal, len(list))
	for i, a := range list {
		out[i] = AccountFlow{AccountID: a.ID, Currency: a.Currency, Values: make([]AccountValues, len(s.intervals))}
		gaps[i] = make([]decimal.Decimal, len(s.intervals))
		at[a.ID] = i
	}
	for _, r := range nets {
		i, ok := at[r.AccountID]
		if !ok {
			continue
		}
		j := s.index(r.TransactionAt)
		if j < 0 {
			next := sort.Search(len(s.intervals), func(k int) bool { return s.intervals[k].Start.After(r.TransactionAt) })
			if next < len(s.intervals) {
				gaps[i][next] = gaps[i][next].Add(r.Net)
			}
			continue
		}
		v := &out[i].Values[j]
		if o, ok := opened[r.AccountID]; ok && o.id == r.ID {
			openingStart[r.AccountID] = openingStart[r.AccountID].Add(r.Net)
			continue
		}
		switch net := r.Net; {
		case r.TransactionType == sqlc.TransactionTypeINC:
			v.Income = v.Income.Add(net)
		case r.TransactionType == sqlc.TransactionTypeEXP:
			v.Expenses = v.Expenses.Sub(net)
		case !isTransfer(r.TransactionType):
			v.Other = v.Other.Add(net)
		case net.IsPositive():
			v.TransfersIn = v.TransfersIn.Add(net)
		default:
			v.TransfersOut = v.TransfersOut.Sub(net)
		}
	}
	start := make(map[string]decimal.Decimal, len(starts))
	for _, r := range starts {
		start[r.AccountID] = r.Start
	}
	// The balance runs on from one interval's end to the next's start.
	for i := range out {
		id := out[i].AccountID
		balance := start[id]
		o, isOpened := opened[id]
		if isOpened {
			out[i].OpenedAt = &o.at
		}
		for j := range out[i].Values {
			v := &out[i].Values[j]
			v.Start = balance.Add(gaps[i][j])
			if isOpened && j == o.interval {
				v.Start = v.Start.Add(openingStart[id])
			}
			v.End = v.Start.Add(v.Income).Sub(v.Expenses).Add(v.TransfersIn).Sub(v.TransfersOut).Add(v.Other)
			balance = v.End
		}
	}
	return out, nil
}
