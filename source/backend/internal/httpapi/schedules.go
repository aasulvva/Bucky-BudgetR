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
	create := svc.Create
	if deref(req.Params.RecordFirst) {
		create = svc.CreateRecordingFirst
	}
	sch, err := create(ctx, sessionFrom(ctx).User.ID, in)
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

func (s *server) PreviewSchedule(ctx context.Context, req api.PreviewScheduleRequestObject) (api.PreviewScheduleResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	b := *req.Body
	minute, err := parseTimeOfDay(b.Time)
	if err != nil {
		return nil, err
	}
	in := schedules.Settings{
		Start: b.StartDate.Time, Minute: minute, TimeZone: deref(b.TimeZone),
		Frequency: sqlc.ScheduleFrequency(b.Frequency), Every: 1, EndCount: deref(b.EndCount),
	}
	if b.Every != nil {
		in.Every = *b.Every
	}
	if b.EndDate != nil {
		in.EndDate = b.EndDate.Time
	}
	count := 5
	if b.Count != nil {
		count = *b.Count
	}
	times, err := svc.Preview(ctx, sessionFrom(ctx).User.ID, in, count)
	if err != nil {
		return nil, scheduleError(err)
	}
	out := make(api.PreviewSchedule200JSONResponse, len(times))
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

func (s *server) GetScheduledTransaction(ctx context.Context, req api.GetScheduledTransactionRequestObject) (api.GetScheduledTransactionResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	o, err := svc.GetOccurrence(ctx, sessionFrom(ctx).User.ID, req.ScheduledTransactionId)
	if err != nil {
		return nil, scheduleError(err)
	}
	return api.GetScheduledTransaction200JSONResponse(toAPIOccurrence(o)), nil
}

func (s *server) ApproveScheduledTransaction(ctx context.Context, req api.ApproveScheduledTransactionRequestObject) (api.ApproveScheduledTransactionResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	var override *transactions.New
	if req.Body != nil {
		n, err := fromAPITransactionCreate(*req.Body)
		if err != nil {
			return nil, err
		}
		override = &n
	}
	o, t, err := svc.Approve(ctx, sessionFrom(ctx).User.ID, req.ScheduledTransactionId, override)
	if err != nil {
		return nil, scheduleError(err)
	}
	return api.ApproveScheduledTransaction200JSONResponse{
		ScheduledTransaction: toAPIOccurrence(o), Transaction: toAPITransaction(t),
	}, nil
}

func (s *server) SkipScheduledTransaction(ctx context.Context, req api.SkipScheduledTransactionRequestObject) (api.SkipScheduledTransactionResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	o, err := svc.Skip(ctx, sessionFrom(ctx).User.ID, req.ScheduledTransactionId)
	if err != nil {
		return nil, scheduleError(err)
	}
	return api.SkipScheduledTransaction200JSONResponse(toAPIOccurrence(o)), nil
}

func (s *server) ListUpcomingTransactions(ctx context.Context, req api.ListUpcomingTransactionsRequestObject) (api.ListUpcomingTransactionsResponseObject, error) {
	svc, err := s.scheduleService()
	if err != nil {
		return nil, err
	}
	count := 5
	if req.Params.Count != nil {
		count = *req.Params.Count
	}
	list, err := svc.UpcomingAll(ctx, sessionFrom(ctx).User.ID, count)
	if err != nil {
		return nil, scheduleError(err)
	}
	out := make(api.ListUpcomingTransactions200JSONResponse, len(list))
	for i, u := range list {
		out[i] = api.UpcomingTransaction{ScheduleId: u.ScheduleID, At: u.At.UTC()}
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
	case errors.Is(err, schedules.ErrResolved):
		return &Error{Status: http.StatusConflict, Code: "already_resolved",
			Detail: "It has been approved or skipped already.", Err: err}
	case errors.Is(err, schedules.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, schedules.ErrInvalid), Err: err}
	}
	return transactionError(err)
}

// parseTimeOfDay returns an HH:MM time of day as minutes after midnight.
// The service checks the range.
func parseTimeOfDay(s string) (int, error) {
	var hh, mm int
	if _, err := fmt.Sscanf(s, "%d:%d", &hh, &mm); err != nil {
		return 0, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "Invalid time of day.", Err: err}
	}
	return hh*60 + mm, nil
}

func fromAPISchedule(b api.ScheduleInput) (schedules.Settings, error) {
	minute, err := parseTimeOfDay(b.Time)
	if err != nil {
		return schedules.Settings{}, err
	}
	in := schedules.Settings{
		Name: deref(b.Name), Mode: sqlc.ScheduleMode(b.Mode), DueDays: schedules.DefaultDueDays,
		Start: b.StartDate.Time, Minute: minute, TimeZone: deref(b.TimeZone),
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
		Type: sqlc.TransactionType(t.Type), Counterparty: deref(t.Counterparty), Description: deref(t.Description), AccountID: t.AccountId,
		ToAccountID: deref(t.ToAccountId), TriggersRefill: t.TriggersRefill, Tags: deref(t.Tags),
	}
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
		Counterparty: &n.Counterparty, Description: &n.Description, Tags: &n.Tags, TriggersRefill: n.TriggersRefill,
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
		Detail: o.Detail, Overdue: o.Overdue, Reason: nullable.NewNullNullable[api.ScheduledTransactionReason](),
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
