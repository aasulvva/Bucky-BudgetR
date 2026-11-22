package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
)

func (s *server) ListSavingsTargets(ctx context.Context, _ api.ListSavingsTargetsRequestObject) (api.ListSavingsTargetsResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListSavingsTargets200JSONResponse, len(list))
	for i, t := range list {
		out[i] = toAPISavingsTarget(t)
	}
	return out, nil
}

func (s *server) CreateSavingsTarget(ctx context.Context, req api.CreateSavingsTargetRequestObject) (api.CreateSavingsTargetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	n := savings.New{}
	if b.BucketId != nil {
		n.BucketID = *b.BucketId
	}
	if b.AccountId != nil {
		n.AccountID = *b.AccountId
	}
	if b.Name != nil {
		n.Name = *b.Name
	}
	if b.Note != nil {
		n.Note = *b.Note
	}
	if n.Goal, err = parseAmount(b.Goal); err != nil {
		return nil, err
	}
	t, err := svc.Create(ctx, sessionFrom(ctx).User.ID, n)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.CreateSavingsTarget201JSONResponse(toAPISavingsTarget(t)), nil
}

func (s *server) GetSavingsTarget(ctx context.Context, req api.GetSavingsTargetRequestObject) (api.GetSavingsTargetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	t, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.TargetId)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.GetSavingsTarget200JSONResponse(toAPISavingsTarget(t)), nil
}

func (s *server) UpdateSavingsTarget(ctx context.Context, req api.UpdateSavingsTargetRequestObject) (api.UpdateSavingsTargetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	c := savings.Changes{Name: b.Name, Note: b.Note}
	if b.Goal != nil {
		goal, err := parseAmount(*b.Goal)
		if err != nil {
			return nil, err
		}
		c.Goal = &goal
	}
	t, err := svc.Update(ctx, sessionFrom(ctx).User.ID, req.TargetId, c)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.UpdateSavingsTarget200JSONResponse(toAPISavingsTarget(t)), nil
}

func (s *server) DeleteSavingsTarget(ctx context.Context, req api.DeleteSavingsTargetRequestObject) (api.DeleteSavingsTargetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	if err := svc.Delete(ctx, sessionFrom(ctx).User.ID, req.TargetId); err != nil {
		return nil, savingsError(err)
	}
	return api.DeleteSavingsTarget204Response{}, nil
}

func (s *server) AddToSavingsTarget(ctx context.Context, req api.AddToSavingsTargetRequestObject) (api.AddToSavingsTargetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	t, err := svc.Add(ctx, sessionFrom(ctx).User.ID, req.TargetId, req.Body.AccountId, amount)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.AddToSavingsTarget200JSONResponse(toAPISavingsTarget(t)), nil
}

func (s *server) SavingsTargetDone(ctx context.Context, req api.SavingsTargetDoneRequestObject) (api.SavingsTargetDoneResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	d := savings.Done{AccountID: b.AccountId}
	if d.Amount, err = parseAmount(b.Amount); err != nil {
		return nil, err
	}
	if b.At != nil {
		d.At = *b.At
	}
	if b.Description != nil {
		d.Description = *b.Description
	}
	t, err := svc.Done(ctx, sessionFrom(ctx).User.ID, req.TargetId, d)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.SavingsTargetDone200JSONResponse(toAPISavingsTarget(t)), nil
}

func (s *server) ClearSavingsTarget(ctx context.Context, req api.ClearSavingsTargetRequestObject) (api.ClearSavingsTargetResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	t, err := svc.Clear(ctx, sessionFrom(ctx).User.ID, req.TargetId, req.Body.AccountId, amount)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.ClearSavingsTarget200JSONResponse(toAPISavingsTarget(t)), nil
}

func (s *server) savingsService() (*savings.Service, error) {
	if s.savings == nil {
		return nil, NewError(http.StatusServiceUnavailable, "savings_unavailable", "")
	}
	return s.savings, nil
}

// savingsError maps errors from the savings service to problems.
func savingsError(err error) error {
	if e := distributorError(err); e != nil {
		return e
	}
	var unallocated *savings.NotEnoughUnallocatedError
	var held *savings.NotEnoughHeldError
	switch {
	case errors.Is(err, savings.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: invalidDetail(err, savings.ErrNotFound), Err: err}
	case errors.Is(err, savings.ErrAlreadyTarget):
		return &Error{Status: http.StatusConflict, Code: "already_target", Detail: "It's a savings target already."}
	case errors.Is(err, savings.ErrNotFullyManual):
		return &Error{Status: http.StatusBadRequest, Code: "not_fully_manual", Detail: "Only a Fully manual bucket can be a savings target."}
	case errors.Is(err, savings.ErrWrongAccountType):
		return &Error{Status: http.StatusBadRequest, Code: "wrong_account_type",
			Detail: "Only a savings, BSU, fund or investment account can be a savings target."}
	case errors.Is(err, savings.ErrGoalAboveCapacity):
		return &Error{Status: http.StatusBadRequest, Code: "goal_above_capacity", Detail: capitalize(err.Error()) + "."}
	case errors.Is(err, savings.ErrAboveCapacity):
		return &Error{Status: http.StatusConflict, Code: "above_capacity", Detail: capitalize(err.Error()) + "."}
	case errors.Is(err, savings.ErrCurrencyMismatch):
		return &Error{Status: http.StatusBadRequest, Code: "currency_mismatch", Detail: "The account isn't in the target's currency."}
	case errors.As(err, &unallocated):
		return &Error{Status: http.StatusConflict, Code: "not_enough_unallocated",
			Detail: "The account has only " + unallocated.Available.StringFixed(money.Places) + " unallocated."}
	case errors.As(err, &held):
		return &Error{Status: http.StatusConflict, Code: "not_enough_held",
			Detail: "Only " + held.Held.StringFixed(money.Places) + " is held on the account."}
	case errors.Is(err, savings.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, savings.ErrInvalid), Err: err}
	}
	return ledgerError(err)
}

func toAPISavingsTarget(t savings.Target) api.SavingsTarget {
	out := api.SavingsTarget{
		Id:         t.ID,
		Name:       t.Name,
		CustomName: nullable.NewNullNullable[string](),
		BucketId:   nullable.NewNullNullable[api.BucketId](),
		AccountId:  nullable.NewNullNullable[api.AccountId](),
		Currency:   t.Currency,
		Goal:       t.Goal.StringFixed(money.Places),
		Note:       t.Note,
		Current:    t.Current.StringFixed(money.Places),
		HeldTotal:  t.HeldTotal().StringFixed(money.Places),
		Held:       make([]api.SavingsHeld, len(t.Held)),
		CreatedAt:  t.CreatedAt.UTC(),
		ModifiedAt: t.ModifiedAt.UTC(),
	}
	if t.CustomName != "" {
		out.CustomName.Set(t.CustomName)
	}
	if t.BucketID != "" {
		out.BucketId.Set(t.BucketID)
	}
	if t.AccountID != "" {
		out.AccountId.Set(t.AccountID)
	}
	for i, h := range t.Held {
		out.Held[i] = api.SavingsHeld{
			AccountId: h.AccountID, Amount: h.Amount.StringFixed(money.Places), Covered: h.Covered.StringFixed(money.Places),
		}
	}
	return out
}
