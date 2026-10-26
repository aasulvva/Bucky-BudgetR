package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func TestCyclesAPI(t *testing.T) {
	pool := testdb.New(t)
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:   auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Cycles: cycles.NewService(pool, cycles.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	day := 24 * time.Hour
	now := time.Now().UTC().Truncate(time.Hour)
	first := map[string]any{"start_at": now.Add(day), "end_at": now.Add(30 * day)}
	second := map[string]any{"start_at": now.Add(30 * day), "end_at": now.Add(60 * day)}

	expect(t, "no session", do(http.MethodGet, "/api/v1/cycles/active", nil, nil), http.StatusUnauthorized, "unauthenticated")

	w := do(http.MethodGet, "/api/v1/cycles/active", nil, alice)
	expect(t, "no cycles", w, http.StatusOK, "")
	if cur := decode[api.CurrentCycles](t, w); !cur.Active.IsNull() || !cur.Next.IsNull() {
		t.Errorf("current %+v, want both null", cur)
	}

	w = do(http.MethodPost, "/api/v1/cycles", first, alice)
	expect(t, "create", w, http.StatusCreated, "")
	c1 := decode[api.Cycle](t, w)
	w = do(http.MethodPost, "/api/v1/cycles", second, alice)
	expect(t, "create second", w, http.StatusCreated, "")
	c2 := decode[api.Cycle](t, w)
	expect(t, "overlap", do(http.MethodPost, "/api/v1/cycles", first, alice), http.StatusConflict, "cycle_overlap")
	expect(t, "end before start", do(http.MethodPost, "/api/v1/cycles",
		map[string]any{"start_at": now.Add(2 * day), "end_at": now.Add(day)}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "bad ID", do(http.MethodGet, "/api/v1/cycles/123", nil, alice), http.StatusBadRequest, "invalid_request")

	expect(t, "start the later one", do(http.MethodPost, "/api/v1/cycles/"+c2.Id+"/start", nil, alice), http.StatusConflict, "not_next_cycle")
	expect(t, "bob starts alice's", do(http.MethodPost, "/api/v1/cycles/"+c1.Id+"/start", nil, bob), http.StatusNotFound, "not_found")
	w = do(http.MethodPost, "/api/v1/cycles/"+c1.Id+"/start", nil, alice)
	expect(t, "start", w, http.StatusOK, "")
	if c := decode[api.Cycle](t, w); c.State != api.CycleStateActive || !c.StartAt.Before(now.Add(day)) {
		t.Errorf("started %+v, want active from now", c)
	}

	w = do(http.MethodGet, "/api/v1/cycles/active", nil, alice)
	expect(t, "current", w, http.StatusOK, "")
	cur := decode[api.CurrentCycles](t, w)
	if a, err := cur.Active.Get(); err != nil || a.Id != c1.Id {
		t.Errorf("active %+v", cur.Active)
	}
	if n, err := cur.Next.Get(); err != nil || n.Id != c2.Id {
		t.Errorf("next %+v", cur.Next)
	}
	w = do(http.MethodGet, "/api/v1/cycles/active", nil, bob)
	if cur := decode[api.CurrentCycles](t, w); !cur.Active.IsNull() {
		t.Errorf("bob sees an active cycle %+v", cur.Active)
	}

	expect(t, "delete the active cycle", do(http.MethodDelete, "/api/v1/cycles/"+c1.Id, nil, alice), http.StatusConflict, "cycle_not_future")
	expect(t, "move the active start", do(http.MethodPatch, "/api/v1/cycles/"+c1.Id,
		map[string]any{"start_at": now.Add(-day)}, alice), http.StatusBadRequest, "invalid_request")

	// End early and start the next cycle now.
	w = do(http.MethodPost, "/api/v1/cycles/"+c1.Id+"/end", map[string]any{"start_next": true}, alice)
	expect(t, "end", w, http.StatusOK, "")
	res := decode[api.CycleEndResult](t, w)
	started, err := res.Started.Get()
	if res.Ended.State != api.CycleStateFinished || err != nil || started.Id != c2.Id || !started.StartAt.Equal(res.Ended.EndAt) {
		t.Errorf("end result %+v", res)
	}
	expect(t, "end again", do(http.MethodPost, "/api/v1/cycles/"+c1.Id+"/end", nil, alice), http.StatusConflict, "cycle_not_active")
	expect(t, "edit finished", do(http.MethodPatch, "/api/v1/cycles/"+c1.Id,
		map[string]any{"end_at": now.Add(90 * day)}, alice), http.StatusConflict, "cycle_finished")

	w = do(http.MethodGet, "/api/v1/cycles", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	if list := decode[[]api.Cycle](t, w); len(list) != 2 || list[0].Id != c1.Id || list[1].State != api.CycleStateActive {
		t.Errorf("list %+v", list)
	}
}
