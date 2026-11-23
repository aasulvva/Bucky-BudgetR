package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
)

// The savings budget's fixed amounts (#234) and sweeps (#235).

func (s *server) ListSavingsBudget(ctx context.Context, _ api.ListSavingsBudgetRequestObject) (api.ListSavingsBudgetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	list, err := svc.ListBudget(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListSavingsBudget200JSONResponse, len(list))
	for i, e := range list {
		out[i] = toAPIBudgetEntry(e)
	}
	return out, nil
}

func (s *server) CreateSavingsBudgetEntry(ctx context.Context, req api.CreateSavingsBudgetEntryRequestObject) (api.CreateSavingsBudgetEntryResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	n := savings.NewBudget{
		AccountID: req.Body.AccountId, When: sqlc.SavingsBudgetWhen(req.Body.When), ThisCycle: req.Body.ThisCycle,
	}
	if req.Body.Amount != nil {
		if n.Amount, err = parseAmount(*req.Body.Amount); err != nil {
			return nil, err
		}
	}
	if req.Body.Keep != nil {
		d, err := parseAmount(*req.Body.Keep)
		if err != nil {
			return nil, err
		}
		n.Keep = &d
	}
	if req.Body.TargetId != nil {
		n.TargetID = *req.Body.TargetId
	}
	e, err := svc.CreateBudget(ctx, sessionFrom(ctx).User.ID, n)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.CreateSavingsBudgetEntry201JSONResponse(toAPIBudgetEntry(e)), nil
}

func (s *server) UpdateSavingsBudgetEntry(ctx context.Context, req api.UpdateSavingsBudgetEntryRequestObject) (api.UpdateSavingsBudgetEntryResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	c := savings.BudgetChanges{ThisCycle: req.Body.ThisCycle}
	if req.Body.TargetId.IsSpecified() {
		target := ""
		if !req.Body.TargetId.IsNull() {
			target = req.Body.TargetId.MustGet()
		}
		c.TargetID = &target
	}
	if req.Body.Amount != nil {
		d, err := parseAmount(*req.Body.Amount)
		if err != nil {
			return nil, err
		}
		c.Amount = &d
	}
	if req.Body.Keep != nil {
		d, err := parseAmount(*req.Body.Keep)
		if err != nil {
			return nil, err
		}
		c.Keep = &d
	}
	if req.Body.When != nil {
		w := sqlc.SavingsBudgetWhen(*req.Body.When)
		c.When = &w
	}
	e, err := svc.UpdateBudget(ctx, sessionFrom(ctx).User.ID, req.EntryId, c)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.UpdateSavingsBudgetEntry200JSONResponse(toAPIBudgetEntry(e)), nil
}

func (s *server) DeleteSavingsBudgetEntry(ctx context.Context, req api.DeleteSavingsBudgetEntryRequestObject) (api.DeleteSavingsBudgetEntryResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	if err := svc.DeleteBudget(ctx, sessionFrom(ctx).User.ID, req.EntryId); err != nil {
		return nil, savingsError(err)
	}
	return api.DeleteSavingsBudgetEntry204Response{}, nil
}

func (s *server) SaveSavingsBudgetEntry(ctx context.Context, req api.SaveSavingsBudgetEntryRequestObject) (api.SaveSavingsBudgetEntryResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	e, err := svc.SaveNow(ctx, sessionFrom(ctx).User.ID, req.EntryId)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.SaveSavingsBudgetEntry200JSONResponse(toAPIBudgetEntry(e)), nil
}

// budgetError maps the savings budget's own errors to problems, nil for
// others.
func budgetError(err error) error {
	if e := cardError(err); e != nil {
		return e
	}
	switch {
	case errors.Is(err, savings.ErrAlreadySaved):
		return &Error{Status: http.StatusConflict, Code: "already_saved", Detail: "It has saved in this cycle already."}
	case errors.Is(err, savings.ErrSweepExists):
		return &Error{Status: http.StatusConflict, Code: "sweep_exists", Detail: "The account has a sweep with this mode already."}
	case errors.Is(err, savings.ErrNoCycle):
		return &Error{Status: http.StatusConflict, Code: "no_active_cycle",
			Detail: "Saving needs an active cycle that holds the current time.", Err: err}
	}
	return nil
}

func toAPIBudgetEntry(e savings.BudgetEntry) api.SavingsBudgetEntry {
	out := api.SavingsBudgetEntry{
		Id: e.ID, AccountId: e.AccountID, TargetId: nullable.NewNullNullable[api.SavingsHolderId](),
		Amount: nullable.NewNullNullable[api.Amount](), Keep: nullable.NewNullNullable[api.Amount](),
		When: api.SavingsBudgetWhen(e.When), Stopped: e.Stopped,
		ThisCycle: nullable.NewNullNullable[api.SavingsBudgetRun](), CreatedAt: e.CreatedAt.UTC(), ModifiedAt: e.ModifiedAt.UTC(),
	}
	if e.IsSweep() {
		out.Keep.Set(e.Keep.StringFixed(money.Places))
	} else {
		out.Amount.Set(e.Amount.StringFixed(money.Places))
	}
	if e.TargetID != "" {
		out.TargetId.Set(e.TargetID)
	}
	if r := e.ThisCycle; r != nil {
		run := api.SavingsBudgetRun{
			Wanted: r.Wanted.StringFixed(money.Places), Reserved: r.Reserved.StringFixed(money.Places),
			At: nullable.NewNullNullable[time.Time](),
		}
		if r.At != nil {
			run.At.Set(r.At.UTC())
		}
		out.ThisCycle.Set(run)
	}
	return out
}
