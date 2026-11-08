package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func (s *server) ListSchedules(ctx context.Context, _ api.ListSchedulesRequestObject) (api.ListSchedulesResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, scheduleError(err)
	}
	out := make(api.ListSchedules200JSONResponse, len(list))
	for i, sch := range list {
		out[i] = toAPISchedule(sch)
	}
	return out, nil
}

func (s *server) CreateSchedule(ctx context.Context, req api.CreateScheduleRequestObject) (api.CreateScheduleResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	in, err := fromAPISchedule(*req.Body)
	if err != nil {
		return nil, err
	}
	sch, err := svc.Create(ctx, sessionFrom(ctx).User.ID, in)
	if err != nil {
		return nil, scheduleError(err)
	}
	return api.CreateSchedule201JSONResponse(toAPISchedule(sch)), nil
}

func (s *server) GetSchedule(ctx context.Context, req api.GetScheduleRequestObject) (api.GetScheduleResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	sch, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.ScheduleId)
	if err != nil {
		return nil, scheduleError(err)
	}
	return api.GetSchedule200JSONResponse(toAPISchedule(sch)), nil
}

func (s *server) UpdateSchedule(ctx context.Context, req api.UpdateScheduleRequestObject) (api.UpdateScheduleResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	in, err := fromAPISchedule(*req.Body)
	if err != nil {
		return nil, err
	}
	sch, err := svc.Update(ctx, sessionFrom(ctx).User.ID, req.ScheduleId, in)
	if err != nil {
		return nil, scheduleError(err)
	}
	return api.UpdateSchedule200JSONResponse(toAPISchedule(sch)), nil
}

func (s *server) DeleteSchedule(ctx context.Context, req api.DeleteScheduleRequestObject) (api.DeleteScheduleResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	if err := svc.Delete(ctx, sessionFrom(ctx).User.ID, req.ScheduleId); err != nil {
		return nil, scheduleError(err)
	}
	return api.DeleteSchedule204Response{}, nil
}

func (s *server) ListUpcoming(ctx context.Context, req api.ListUpcomingRequestObject) (api.ListUpcomingResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	count := 5
	if req.Params.Count != nil {
		count = *req.Params.Count
	}
	times, err := svc.Upcoming(ctx, sessionFrom(ctx).User.ID, req.ScheduleId, count)
	if err != nil {
		return nil, scheduleError(err)
	}
	out := make(api.ListUpcoming200JSONResponse, len(times))
	for i, t := range times {
		out[i] = t.UTC()
	}
	return out, nil
}

func (s *server) ListScheduledTransactions(ctx context.Context, req api.ListScheduledTransactionsRequestObject) (api.ListScheduledTransactionsResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	p := req.Params
	f := schedules.Filter{ScheduleID: deref(p.ScheduleId), Limit: deref(p.Limit), Cursor: deref(p.Cursor)}
	if p.State != nil {
		f.State = sqlc.OccurrenceState(*p.State)
	}
	page, err := svc.Occurrences(ctx, sessionFrom(ctx).User.ID, f)
	if err != nil {
		return nil, scheduleError(err)
	}
	out := api.ListScheduledTransactions200JSONResponse{Items: make([]api.ScheduledTransaction, len(page.Items)), NextCursor: nullable.NewNullNullable[string]()}
	for i, o := range page.Items {
		out.Items[i] = toAPIOccurrence(o)
	}
	if page.Next != "" {
		out.NextCursor.Set(page.Next)
	}
	return out, nil
}

func (s *server) scheduleService() (*schedules.Service, error) {
	if s.schedules == nil {
		return nil, NewError(http.StatusServiceUnavailable, "schedules_unavailable", "")
	}
	return s.schedules, nil
}

// scheduleError maps errors from the schedules service to problems. The
// transaction part is checked as for a new transaction.
func scheduleError(err error) error {
	switch {
	case errors.Is(err, schedules.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Schedule not found.", Err: err}
	case errors.Is(err, schedules.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, schedules.ErrInvalid), Err: err}
	}
	return transactionError(err)
}

func fromAPISchedule(b api.ScheduleInput) (schedules.Settings, error) {
	var hh, mm int
	if _, err := fmt.Sscanf(b.Time, "%d:%d", &hh, &mm); err != nil {
		return schedules.Settings{}, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "Invalid time of day.", Err: err}
	}
	in := schedules.Settings{
		Name: deref(b.Name), Mode: sqlc.ScheduleMode(b.Mode), DueDays: schedules.DefaultDueDays,
		Start: b.StartDate.Time, Minute: hh*60 + mm, TimeZone: deref(b.TimeZone),
		Frequency: sqlc.ScheduleFrequency(b.Frequency), Every: 1, EndCount: deref(b.EndCount), Paused: deref(b.Paused),
	}
	if b.DueDays != nil {
		in.DueDays = *b.DueDays
	}
	if b.Every != nil {
		in.Every = *b.Every
	}
	if b.EndDate != nil {
		in.EndDate = b.EndDate.Time
	}
	t := b.Transaction
	in.Transaction = transactions.New{
		Type: sqlc.TransactionType(t.Type), Counterparty: deref(t.Counterparty), AccountID: t.AccountId,
		ToAccountID: deref(t.ToAccountId), TriggersRefill: t.TriggersRefill, Tags: deref(t.Tags),
	}
	var err error
	if in.Transaction.Amount, err = parseAmount(t.Amount); err != nil {
		return schedules.Settings{}, err
	}
	if t.BucketLines != nil {
		for _, l := range *t.BucketLines {
			amount, err := parseAmount(l.Amount)
			if err != nil {
				return schedules.Settings{}, err
			}
			in.Transaction.Buckets = append(in.Transaction.Buckets, transactions.BucketAmount{BucketID: l.BucketId, Amount: amount})
		}
	}
	return in, nil
}

func toAPISchedule(s schedules.Schedule) api.Schedule {
	n := s.Transaction
	t := api.ScheduleTransaction{
		Type: api.ScheduleTransactionType(n.Type), AccountId: n.AccountID, Amount: n.Amount.StringFixed(money.Places),
		Counterparty: &n.Counterparty, Tags: &n.Tags, TriggersRefill: n.TriggersRefill,
	}
	if n.ToAccountID != "" {
		t.ToAccountId = &n.ToAccountID
	}
	lines := make([]struct {
		Amount   api.Amount   `json:"amount"`
		BucketId api.BucketId `json:"bucket_id"`
	}, len(n.Buckets))
	for i, l := range n.Buckets {
		lines[i].Amount, lines[i].BucketId = l.Amount.StringFixed(money.Places), l.BucketID
	}
	t.BucketLines = &lines
	out := api.Schedule{
		Id: s.ID, Name: s.Name, Transaction: t, Mode: api.ScheduleMode(s.Mode), DueDays: s.DueDays,
		StartDate: openapi_types.Date{Time: s.Start}, Time: fmt.Sprintf("%02d:%02d", s.Minute/60, s.Minute%60),
		TimeZone: s.TimeZone, Frequency: api.ScheduleFrequency(s.Frequency), Every: s.Every, Paused: s.Paused,
		NextIndex: s.NextIndex, CreatedAt: s.CreatedAt.UTC(), UpdatedAt: s.UpdatedAt.UTC(),
		EndCount: nullable.NewNullNullable[int](), EndDate: nullable.NewNullNullable[openapi_types.Date](),
		NextAt: nullable.NewNullNullable[time.Time](),
	}
	if s.EndCount > 0 {
		out.EndCount.Set(s.EndCount)
	}
	if !s.EndDate.IsZero() {
		out.EndDate.Set(openapi_types.Date{Time: s.EndDate})
	}
	if !s.NextAt.IsZero() {
		out.NextAt.Set(s.NextAt.UTC())
	}
	return out
}

func toAPIOccurrence(o schedules.Occurrence) api.ScheduledTransaction {
	out := api.ScheduledTransaction{
		Id: o.ID, ScheduleId: o.ScheduleID, ScheduledAt: o.ScheduledAt.UTC(), State: api.ScheduledTransactionState(o.State),
		Detail: o.Detail, Reason: nullable.NewNullNullable[api.ScheduledTransactionReason](),
		QueuedAt: nullable.NewNullNullable[time.Time](), DueAt: nullable.NewNullNullable[time.Time](),
		TransactionId: nullable.NewNullNullable[api.TransactionId](), ResolvedAt: nullable.NewNullNullable[time.Time](),
	}
	if o.Reason != "" {
		out.Reason.Set(api.ScheduledTransactionReason(o.Reason))
	}
	setTime := func(n *nullable.Nullable[time.Time], t time.Time) {
		if !t.IsZero() {
			n.Set(t.UTC())
		}
	}
	setTime(&out.QueuedAt, o.QueuedAt)
	setTime(&out.DueAt, o.DueAt)
	setTime(&out.ResolvedAt, o.ResolvedAt)
	if o.TransactionID != "" {
		out.TransactionId.Set(o.TransactionID)
	}
	return out
}
