package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/oapi-codegen/nullable"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/stats"
)

func (s *server) GetStatsSeries(ctx context.Context, req api.GetStatsSeriesRequestObject) (api.GetStatsSeriesResponseObject, error) {
	user := sessionFrom(ctx).User
	p := req.Params
	loc, err := statsLocation(user.Preferences, p.TimeZone)
	if err != nil {
		return nil, err
	}
	q := stats.Query{
		Metric:     stats.Metric(p.Metric),
		From:       p.From,
		To:         p.To,
		Resolution: stats.Resolution(p.Resolution),
		Location:   loc,
		WeekStart:  time.Monday,
		GroupBy:    stats.ByNone,
	}
	if p.WeekStart != nil {
		q.WeekStart = time.Weekday(*p.WeekStart % 7) // ISO 7 (Sunday) is Go's 0.
	}
	if p.GroupBy != nil {
		q.GroupBy = stats.GroupBy(*p.GroupBy)
	}
	if p.AccountId != nil {
		q.AccountIDs = *p.AccountId
	}
	if p.BucketId != nil {
		q.BucketIDs = *p.BucketId
	}
	if p.Tag != nil {
		q.Tags = *p.Tag
	}
	if p.Counterparty != nil {
		q.Counterparty = *p.Counterparty
	}
	if p.Transfers != nil {
		q.Transfers = *p.Transfers
	}

	res, err := s.accounts.Stats(ctx, user.ID, q)
	if err != nil {
		return nil, statsError(err)
	}

	out := api.GetStatsSeries200JSONResponse{
		Intervals: make([]api.StatsInterval, len(res.Intervals)),
		Series:    make([]api.StatsSeriesLine, len(res.Series)),
	}
	for i, iv := range res.Intervals {
		out.Intervals[i] = api.StatsInterval{Start: iv.Start.UTC(), End: iv.End.UTC()}
	}
	for i, l := range res.Series {
		line := api.StatsSeriesLine{Currency: l.Currency, Values: make([]api.Amount, len(l.Values))}
		for j, v := range l.Values {
			line.Values[j] = v.StringFixed(money.Places)
		}
		if l.AccountID != "" {
			line.AccountId = &l.AccountID
		}
		switch {
		case l.NoBucket:
			line.BucketId = nullable.NewNullNullable[api.BucketId]()
		case l.BucketID != "":
			line.BucketId = nullable.NewNullableWithValue(l.BucketID)
		}
		switch {
		case l.NoCounterparty:
			line.Counterparty = nullable.NewNullNullable[string]()
		case l.Counterparty != "":
			line.Counterparty = nullable.NewNullableWithValue(l.Counterparty)
		}
		if l.Transfers {
			line.Transfers = &l.Transfers
		}
		out.Series[i] = line
	}
	return out, nil
}

// statsLocation is the zone intervals are cut in: the given one, else the
// user's, else UTC. An unknown zone is a 400.
func statsLocation(preferences []byte, given *string) (*time.Location, error) {
	zone := ""
	if given != nil {
		zone = *given
	} else if prefs, err := toAPIPreferences(preferences); err == nil {
		zone, _ = prefs.TimeZone.Get()
	}
	if zone == "" {
		return time.UTC, nil
	}
	loc, err := time.LoadLocation(zone)
	if err != nil || zone == "Local" {
		return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "Unknown time zone " + strconv.Quote(zone) + "."}
	}
	return loc, nil
}

// statsError maps the stats package's errors to problems.
func statsError(err error) error {
	switch {
	case errors.Is(err, stats.ErrTooMany):
		return &Error{Status: http.StatusBadRequest, Code: "too_many_intervals",
			Detail: "The period has more than " + strconv.Itoa(stats.MaxIntervals) + " intervals at this resolution. Choose a longer one."}
	case errors.Is(err, stats.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, stats.ErrInvalid), Err: err}
	}
	return err
}

func (s *server) GetStatsFlows(ctx context.Context, req api.GetStatsFlowsRequestObject) (api.GetStatsFlowsResponseObject, error) {
	user := sessionFrom(ctx).User
	p := req.Params
	loc, err := statsLocation(user.Preferences, p.TimeZone)
	if err != nil {
		return nil, err
	}
	q := stats.FlowsQuery{From: p.From, To: p.To, Resolution: stats.Resolution(p.Resolution), Location: loc}
	if p.AccountId != nil {
		q.AccountIDs = *p.AccountId
	}
	if p.BucketId != nil {
		q.BucketIDs = *p.BucketId
	}
	res, err := s.accounts.StatsFlows(ctx, user.ID, q)
	if err != nil {
		return nil, statsError(err)
	}

	amount := func(d decimal.Decimal) string { return d.StringFixed(money.Places) }
	out := api.GetStatsFlows200JSONResponse{
		Intervals: make([]api.StatsInterval, len(res.Intervals)),
		Buckets:   make([]api.BucketFlow, len(res.Buckets)),
		Accounts:  make([]api.AccountFlowSeries, len(res.Accounts)),
	}
	for i, iv := range res.Intervals {
		out.Intervals[i] = api.StatsInterval{Start: iv.Start.UTC(), End: iv.End.UTC()}
	}
	for i, b := range res.Buckets {
		f := api.BucketFlow{BucketId: b.BucketID, AccountId: b.AccountID, Currency: b.Currency, Values: make([]api.BucketFlowValues, len(b.Values))}
		for j, v := range b.Values {
			f.Values[j] = api.BucketFlowValues{
				Start: amount(v.Start), Refills: amount(v.Refills), Income: amount(v.Income), OpeningFunds: amount(v.Opening),
				AdjustmentsIn: amount(v.AdjustmentsIn), AdjustmentsOut: amount(v.AdjustmentsOut),
				TransfersIn: amount(v.TransfersIn), TransfersOut: amount(v.TransfersOut),
				Spent: amount(v.Spent), Overflow: amount(v.Overflow), In: amount(v.In), Out: amount(v.Out), End: amount(v.End),
			}
		}
		out.Buckets[i] = f
	}
	for i, a := range res.Accounts {
		f := api.AccountFlowSeries{AccountId: a.AccountID, Currency: a.Currency, Values: make([]api.AccountFlowValues, len(a.Values))}
		for j, v := range a.Values {
			f.Values[j] = api.AccountFlowValues{
				Income: amount(v.Income), Expenses: amount(v.Expenses),
				TransfersIn: amount(v.TransfersIn), TransfersOut: amount(v.TransfersOut),
			}
		}
		out.Accounts[i] = f
	}
	return out, nil
}
