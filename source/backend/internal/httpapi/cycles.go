package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

func (s *server) ListCycles(ctx context.Context, _ api.ListCyclesRequestObject) (api.ListCyclesResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListCycles200JSONResponse, len(list))
	for i, c := range list {
		out[i] = toAPICycle(c)
	}
	return out, nil
}

func (s *server) CreateCycle(ctx context.Context, req api.CreateCycleRequestObject) (api.CreateCycleResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	c, err := svc.Create(ctx, sessionFrom(ctx).User.ID, req.Body.StartAt, req.Body.EndAt)
	if err != nil {
		return nil, cycleError(err)
	}
	return api.CreateCycle201JSONResponse(toAPICycle(c)), nil
}

func (s *server) GetCurrentCycles(ctx context.Context, _ api.GetCurrentCyclesRequestObject) (api.GetCurrentCyclesResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	cur, err := svc.Current(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	return api.GetCurrentCycles200JSONResponse{Active: nullableCycle(cur.Active), Next: nullableCycle(cur.Next)}, nil
}

func (s *server) GetCycle(ctx context.Context, req api.GetCycleRequestObject) (api.GetCycleResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	c, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.CycleId)
	if err != nil {
		return nil, cycleError(err)
	}
	return api.GetCycle200JSONResponse(toAPICycle(c)), nil
}

func (s *server) UpdateCycle(ctx context.Context, req api.UpdateCycleRequestObject) (api.UpdateCycleResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	c, err := svc.Update(ctx, sessionFrom(ctx).User.ID, req.CycleId, cycles.Changes{StartAt: req.Body.StartAt, EndAt: req.Body.EndAt})
	if err != nil {
		return nil, cycleError(err)
	}
	return api.UpdateCycle200JSONResponse(toAPICycle(c)), nil
}

func (s *server) DeleteCycle(ctx context.Context, req api.DeleteCycleRequestObject) (api.DeleteCycleResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	if err := svc.Delete(ctx, sessionFrom(ctx).User.ID, req.CycleId); err != nil {
		return nil, cycleError(err)
	}
	return api.DeleteCycle204Response{}, nil
}

func (s *server) StartCycle(ctx context.Context, req api.StartCycleRequestObject) (api.StartCycleResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	c, err := svc.Start(ctx, sessionFrom(ctx).User.ID, req.CycleId)
	if err != nil {
		return nil, cycleError(err)
	}
	return api.StartCycle200JSONResponse(toAPICycle(c)), nil
}

func (s *server) EndCycle(ctx context.Context, req api.EndCycleRequestObject) (api.EndCycleResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	startNext := req.Body != nil && req.Body.StartNext != nil && *req.Body.StartNext
	res, err := svc.End(ctx, sessionFrom(ctx).User.ID, req.CycleId, startNext)
	if err != nil {
		return nil, cycleError(err)
	}
	return api.EndCycle200JSONResponse{Ended: toAPICycle(res.Ended), Started: nullableCycle(res.Started)}, nil
}

func (s *server) cycleService() (*cycles.Service, error) {
	if s.cycles == nil {
		return nil, NewError(http.StatusServiceUnavailable, "cycles_unavailable", "")
	}
	return s.cycles, nil
}

// cycleError maps errors from the cycles service to problems.
func cycleError(err error) error {
	conflict := func(code, detail string) error {
		return &Error{Status: http.StatusConflict, Code: code, Detail: detail}
	}
	switch {
	case errors.Is(err, cycles.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Cycle not found.", Err: err}
	case errors.Is(err, cycles.ErrOverlap):
		return conflict("cycle_overlap", "The cycle would overlap another cycle.")
	case errors.Is(err, cycles.ErrFinished):
		return conflict("cycle_finished", "A finished cycle can't be changed.")
	case errors.Is(err, cycles.ErrNotFuture):
		return conflict("cycle_not_future", "The cycle has already started.")
	case errors.Is(err, cycles.ErrNotActive):
		return conflict("cycle_not_active", "Only the active cycle can be ended.")
	case errors.Is(err, cycles.ErrActiveExists):
		return conflict("active_cycle_exists", "Another cycle is active. End it first.")
	case errors.Is(err, cycles.ErrNotNext):
		return conflict("not_next_cycle", "An earlier cycle is planned. Start that one first.")
	case errors.Is(err, cycles.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, cycles.ErrInvalid), Err: err}
	}
	return err
}

func toAPICycle(c sqlc.Cycle) api.Cycle {
	return api.Cycle{
		Id:        c.ID,
		StartAt:   c.StartAt.UTC(),
		EndAt:     c.EndAt.UTC(),
		State:     api.CycleState(c.State),
		CreatedAt: c.CreatedAt.UTC(),
	}
}

func nullableCycle(c *sqlc.Cycle) nullable.Nullable[api.Cycle] {
	if c == nil {
		return nullable.NewNullNullable[api.Cycle]()
	}
	return nullable.NewNullableWithValue(toAPICycle(*c))
}
