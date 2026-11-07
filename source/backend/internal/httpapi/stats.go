package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/stats"
)

func (s *server) GetStatsSeries(ctx context.Context, req api.GetStatsSeriesRequestObject) (api.GetStatsSeriesResponseObject, error) {
	user := sessionFrom(ctx).User
	p := req.Params
	invalid := func(detail string) error {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: detail}
	}

	// The intervals are cut in the given zone, else the user's, else UTC.
	zone := ""
	if p.TimeZone != nil {
		zone = *p.TimeZone
	} else if prefs, err := toAPIPreferences(user.Preferences); err == nil {
		zone, _ = prefs.TimeZone.Get()
	}
	loc := time.UTC
	if zone != "" {
		var err error
		if loc, err = time.LoadLocation(zone); err != nil || zone == "Local" {
			return nil, invalid("Unknown time zone " + strconv.Quote(zone) + ".")
		}
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
	switch {
	case errors.Is(err, stats.ErrTooMany):
		return nil, &Error{Status: http.StatusBadRequest, Code: "too_many_intervals",
			Detail: "The period has more than " + strconv.Itoa(stats.MaxIntervals) + " intervals at this resolution. Choose a longer one."}
	case errors.Is(err, stats.ErrInvalid):
		return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, stats.ErrInvalid), Err: err}
	case err != nil:
		return nil, err
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
		out.Series[i] = line
	}
	return out, nil
}
