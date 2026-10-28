package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
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

func (s *server) CycleRulePeriods(ctx context.Context, req api.CycleRulePeriodsRequestObject) (api.CycleRulePeriodsResponseObject, error) {
	svc, err := s.cycleService()
	if err != nil {
		return nil, err
	}
	r := req.Body.Rule
	rule := cycles.Rule{Day: r.Day, Shift: calendar.Shift(r.Shift), Holidays: calendar.Holidays(r.Holidays), Ahead: r.Ahead}
	var from *calendar.Date
	if req.Body.From != nil {
		d := calendar.DateOf(req.Body.From.Time)
		from = &d
	}
	n := 4
	if req.Body.Count != nil {
		n = *req.Body.Count
	}
	periods, err := svc.Periods(ctx, sessionFrom(ctx).User.ID, rule, from, n)
	if err != nil {
		return nil, err
	}
	out := make(api.CycleRulePeriods200JSONResponse, len(periods))
	for i, p := range periods {
		out[i] = api.CyclePeriod{
			Start: openapi_types.Date{Time: p.Start.Time(time.UTC)},
			End:   openapi_types.Date{Time: p.End.Time(time.UTC)},
		}
	}
	return out, nil
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
		Generated: c.Generated,
		CreatedAt: c.CreatedAt.UTC(),
	}
}

func nullableCycle(c *sqlc.Cycle) nullable.Nullable[api.Cycle] {
	if c == nil {
		return nullable.NewNullNullable[api.Cycle]()
	}
	return nullable.NewNullableWithValue(toAPICycle(*c))
}
