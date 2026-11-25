package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/planned"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// Planned purchases (#265, spec §5.7).

func (s *server) ListPlannedPurchases(ctx context.Context, req api.ListPlannedPurchasesRequestObject) (api.ListPlannedPurchasesResponseObject, error) {
	svc, err := s.plannedService()
	if err != nil {
		return nil, err
	}
	closed := req.Params.Status != nil && *req.Params.Status == api.ListPlannedPurchasesParamsStatusClosed
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID, closed)
	if err != nil {
		return nil, plannedError(err)
	}
	out := make(api.ListPlannedPurchases200JSONResponse, len(list))
	for i, p := range list {
		out[i] = toAPIPlanned(p)
	}
	return out, nil
}

func (s *server) CreatePlannedPurchase(ctx context.Context, req api.CreatePlannedPurchaseRequestObject) (api.CreatePlannedPurchaseResponseObject, error) {
	svc, err := s.plannedService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	in := planned.Settings{Name: b.Name, AccountID: b.AccountId, ExpectedAt: b.ExpectedAt, Note: deref(b.Note)}
	if in.Amount, err = parseAmount(b.Amount); err != nil {
		return nil, err
	}
	if in.Buckets, err = fromAPIPlannedLines(b.BucketLines); err != nil {
		return nil, err
	}
	p, err := svc.Create(ctx, sessionFrom(ctx).User.ID, in)
	if err != nil {
		return nil, plannedError(err)
	}
	return api.CreatePlannedPurchase201JSONResponse(toAPIPlanned(p)), nil
}

func (s *server) GetPlannedPurchase(ctx context.Context, req api.GetPlannedPurchaseRequestObject) (api.GetPlannedPurchaseResponseObject, error) {
	svc, err := s.plannedService()
	if err != nil {
		return nil, err
	}
	p, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.PlannedId)
	if err != nil {
		return nil, plannedError(err)
	}
	return api.GetPlannedPurchase200JSONResponse(toAPIPlanned(p)), nil
}

func (s *server) UpdatePlannedPurchase(ctx context.Context, req api.UpdatePlannedPurchaseRequestObject) (api.UpdatePlannedPurchaseResponseObject, error) {
	svc, err := s.plannedService()
	if err != nil {
		return nil, err
	}
	userID := sessionFrom(ctx).User.ID
	cur, err := svc.Get(ctx, userID, req.PlannedId)
	if err != nil {
		return nil, plannedError(err)
	}
	in := cur.Settings
	b := req.Body
	if b.Name != nil {
		in.Name = *b.Name
	}
	if b.AccountId != nil {
		in.AccountID = *b.AccountId
	}
	if b.Amount != nil {
		if in.Amount, err = parseAmount(*b.Amount); err != nil {
			return nil, err
		}
	}
	if b.ExpectedAt != nil {
		in.ExpectedAt = *b.ExpectedAt
	}
	if b.Note != nil {
		in.Note = *b.Note
	}
	if b.BucketLines != nil {
		if in.Buckets, err = fromAPIPlannedLines(b.BucketLines); err != nil {
			return nil, err
		}
	}
	p, err := svc.Update(ctx, userID, req.PlannedId, in)
	if err != nil {
		return nil, plannedError(err)
	}
	return api.UpdatePlannedPurchase200JSONResponse(toAPIPlanned(p)), nil
}

func (s *server) CancelPlannedPurchase(ctx context.Context, req api.CancelPlannedPurchaseRequestObject) (api.CancelPlannedPurchaseResponseObject, error) {
	svc, err := s.plannedService()
	if err != nil {
		return nil, err
	}
	if err := svc.Cancel(ctx, sessionFrom(ctx).User.ID, req.PlannedId); err != nil {
		return nil, plannedError(err)
	}
	return api.CancelPlannedPurchase204Response{}, nil
}

func (s *server) plannedService() (*planned.Service, error) {
	if s.planned == nil {
		return nil, NewError(http.StatusServiceUnavailable, "planned_unavailable", "")
	}
	return s.planned, nil
}

// plannedError maps errors from the planned purchases service to problems.
func plannedError(err error) error {
	switch {
	case errors.Is(err, planned.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Planned purchase not found.", Err: err}
	case errors.Is(err, planned.ErrClosed):
		return plannedClosed(err)
	case errors.Is(err, planned.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, planned.ErrInvalid), Err: err}
	}
	return transactionError(err)
}

func plannedClosed(err error) error {
	return &Error{Status: http.StatusConflict, Code: "planned_closed",
		Detail: "The planned purchase is already charged or cancelled.", Err: err}
}

func fromAPIPlannedLines(lines *[]api.PlannedBucketLine) ([]transactions.BucketAmount, error) {
	if lines == nil {
		return nil, nil
	}
	out := make([]transactions.BucketAmount, 0, len(*lines))
	for _, l := range *lines {
		amount, err := parseAmount(l.Amount)
		if err != nil {
			return nil, err
		}
		out = append(out, transactions.BucketAmount{BucketID: l.BucketId, Amount: amount})
	}
	return out, nil
}

func toAPIPlanned(p planned.Plan) api.PlannedPurchase {
	text := func(v string) nullable.Nullable[string] {
		if v == "" {
			return nullable.NewNullNullable[string]()
		}
		return nullable.NewNullableWithValue(v)
	}
	out := api.PlannedPurchase{
		Id: p.ID, Name: p.Name, AccountId: p.AccountID, Amount: p.Amount.StringFixed(money.Places),
		Currency: p.Currency, ExpectedAt: p.ExpectedAt.UTC(), Note: p.Note, Status: api.PlannedPurchaseStatus(p.Status),
		TransactionId: text(p.TransactionID), CycleId: text(p.CycleID), Overdue: p.Overdue,
		BucketLines: make([]api.PlannedBucketLine, len(p.Buckets)), CreatedAt: p.CreatedAt.UTC(), UpdatedAt: p.UpdatedAt.UTC(),
	}
	for i, l := range p.Buckets {
		out.BucketLines[i] = api.PlannedBucketLine{BucketId: l.BucketID, Amount: l.Amount.StringFixed(money.Places)}
	}
	return out
}
