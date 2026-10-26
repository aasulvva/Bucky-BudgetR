package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func TestBucketsAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	refills := refill.NewService(pool, l, refill.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:     auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts: accounts.NewService(pool, l, accounts.Options{}),
		Cycles:   cycles.NewService(pool, cycles.Options{}),
		Buckets:  buckets.NewService(pool, l, buckets.Options{OnCreate: refills.OnCreate}),
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "10000"}, alice)
	expect(t, "create account", w, http.StatusCreated, "")
	acc := decode[api.Account](t, w)
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Euro", "currency": "EUR"}, alice)
	expect(t, "create EUR account", w, http.StatusCreated, "")
	eur := decode[api.Account](t, w)

	expect(t, "no session", do(http.MethodGet, "/api/v1/buckets", nil, nil), http.StatusUnauthorized, "unauthenticated")

	// The preference sets the default refill mode.
	w = do(http.MethodPatch, "/api/v1/me/preferences", map[string]any{"default_refill_mode": "manual"}, alice)
	expect(t, "set preference", w, http.StatusOK, "")
	if p := decode[api.Preferences](t, w); p.DefaultRefillMode.MustGet() != api.Manual {
		t.Errorf("preferences %+v", p)
	}
	expect(t, "bad preference", do(http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"default_refill_mode": "weekly"}, alice), http.StatusBadRequest, "invalid_request")

	w = do(http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Groceries", "source_account_id": acc.Id, "refill_amount": "4000", "cap_multiplier": "1.25",
	}, alice)
	expect(t, "create", w, http.StatusCreated, "")
	b := decode[api.Bucket](t, w)
	if b.Capacity != "5000.00" || b.CapMultiplier.MustGet() != "1.25" || !b.CapAmount.IsNull() ||
		b.RefillMode != api.Manual || b.Currency != "NOK" || b.TargetFunds != "0.00" || b.CurrentAvailableFunds != "0.00" {
		t.Errorf("created %+v", b)
	}

	expect(t, "duplicate name", do(http.MethodPost, "/api/v1/buckets",
		map[string]any{"name": "groceries", "source_account_id": acc.Id}, alice), http.StatusConflict, "name_taken")
	expect(t, "savings overflow", do(http.MethodPost, "/api/v1/buckets",
		map[string]any{"name": "Fun", "source_account_id": acc.Id, "overflow_destination": "savings_target"}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "opening funds without a cycle", do(http.MethodPost, "/api/v1/buckets",
		map[string]any{"name": "Fun", "source_account_id": acc.Id, "opening_funds": "100"}, alice), http.StatusConflict, "no_active_cycle")
	expect(t, "refill without a cycle", do(http.MethodPost, "/api/v1/buckets",
		map[string]any{"name": "Fun", "source_account_id": acc.Id, "refill": true}, alice), http.StatusConflict, "no_active_cycle")
	expect(t, "bob's source account", do(http.MethodPost, "/api/v1/buckets",
		map[string]any{"name": "Fun", "source_account_id": acc.Id}, bob), http.StatusBadRequest, "invalid_request")
	expect(t, "bad ID", do(http.MethodGet, "/api/v1/buckets/123", nil, alice), http.StatusBadRequest, "invalid_request")

	expect(t, "bob gets alice's", do(http.MethodGet, "/api/v1/buckets/"+b.Id, nil, bob), http.StatusNotFound, "not_found")
	w = do(http.MethodGet, "/api/v1/buckets/"+b.Id, nil, alice)
	expect(t, "get", w, http.StatusOK, "")

	w = do(http.MethodPatch, "/api/v1/buckets/"+b.Id, map[string]any{"cap_mode": "fixed", "cap_amount": "4500", "priority": true}, alice)
	expect(t, "update", w, http.StatusOK, "")
	if u := decode[api.Bucket](t, w); u.Capacity != "4500.00" || u.CapAmount.MustGet() != "4500.00" || !u.CapMultiplier.IsNull() || !u.Priority {
		t.Errorf("updated %+v", u)
	}
	w = do(http.MethodPost, "/api/v1/buckets/refill-amounts", map[string]any{
		"items": []map[string]any{{"bucket_id": b.Id, "refill_amount": "4800"}},
	}, alice)
	expect(t, "set refill amounts", w, http.StatusOK, "")
	if u := decode[struct{ Items []api.Bucket }](t, w).Items; len(u) != 1 || u[0].RefillAmount != "4800.00" || u[0].Capacity != "4800.00" {
		t.Errorf("refill amounts %+v, want RA 4800 with the fixed BC raised", u)
	}
	expect(t, "refill amounts twice", do(http.MethodPost, "/api/v1/buckets/refill-amounts", map[string]any{
		"items": []map[string]any{{"bucket_id": b.Id, "refill_amount": "1"}, {"bucket_id": b.Id, "refill_amount": "2"}},
	}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "no refill amounts", do(http.MethodPost, "/api/v1/buckets/refill-amounts",
		map[string]any{"items": []map[string]any{}}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "bob's refill amounts", do(http.MethodPost, "/api/v1/buckets/refill-amounts", map[string]any{
		"items": []map[string]any{{"bucket_id": b.Id, "refill_amount": "1"}},
	}, bob), http.StatusNotFound, "not_found")
	expect(t, "to EUR", do(http.MethodPatch, "/api/v1/buckets/"+b.Id,
		map[string]any{"source_account_id": eur.Id}, alice), http.StatusBadRequest, "currency_mismatch")
	expect(t, "empty update", do(http.MethodPatch, "/api/v1/buckets/"+b.Id, map[string]any{}, alice), http.StatusBadRequest, "invalid_request")

	// With an active cycle, opening funds are recorded and released on delete.
	now := time.Now().UTC()
	w = do(http.MethodPost, "/api/v1/cycles", map[string]any{"start_at": now.Add(time.Hour), "end_at": now.Add(30 * 24 * time.Hour)}, alice)
	expect(t, "create cycle", w, http.StatusCreated, "")
	cycle := decode[api.Cycle](t, w).Id
	expect(t, "start cycle", do(http.MethodPost, "/api/v1/cycles/"+cycle+"/start", nil, alice), http.StatusOK, "")
	w = do(http.MethodPost, "/api/v1/buckets", map[string]any{"name": "Fun", "source_account_id": acc.Id, "opening_funds": "100"}, alice)
	expect(t, "create with opening funds", w, http.StatusCreated, "")
	fun := decode[api.Bucket](t, w)
	if fun.TargetFunds != "100.00" || !fun.Refilled {
		t.Errorf("TF %s, refilled %v; want 100.00, the opening funds counting as the refill", fun.TargetFunds, fun.Refilled)
	}
	expect(t, "opening funds and refill", do(http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Car", "source_account_id": acc.Id, "opening_funds": "100", "refill": true,
	}, alice), http.StatusBadRequest, "invalid_request")
	w = do(http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Car", "source_account_id": acc.Id, "refill_amount": "500", "refill": true,
	}, alice)
	expect(t, "create refilled", w, http.StatusCreated, "")
	car := decode[api.Bucket](t, w)
	if car.TargetFunds != "500.00" || !car.Refilled {
		t.Errorf("TF %s, refilled %v; want 500.00, refilled", car.TargetFunds, car.Refilled)
	}
	expect(t, "delete refilled", do(http.MethodDelete, "/api/v1/buckets/"+car.Id, nil, alice), http.StatusNoContent, "")

	w = do(http.MethodGet, "/api/v1/buckets", nil, alice)
	expect(t, "list", w, http.StatusOK, "")
	if list := decode[[]api.Bucket](t, w); len(list) != 2 || list[0].Id != fun.Id || list[1].Id != b.Id {
		t.Errorf("list %+v, want Fun, Groceries", list)
	}

	// The cycle's figures, per bucket that isn't deleted, sorted by ID. The
	// balance package tests the sums.
	figures := func(who *http.Cookie) []api.BucketFigures {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/cycles/"+cycle+"/bucket-figures", nil, who)
		expect(t, "figures", w, http.StatusOK, "")
		return decode[[]api.BucketFigures](t, w)
	}
	figs := figures(alice)
	if len(figs) != 2 || figs[0].BucketId > figs[1].BucketId {
		t.Fatalf("figures %+v, want two sorted by ID", figs)
	}
	for _, f := range figs {
		want := api.BucketFigures{BucketId: f.BucketId, Start: "0.00", Refills: "0.00", Income: "0.00",
			OpeningFunds: "0.00", Adjustments: "0.00", Transfers: "0.00", Budget: "0.00", Used: "0.00", Overflow: "0.00", Left: "0.00"}
		if f.BucketId == fun.Id {
			want.OpeningFunds, want.Budget, want.Left = "100.00", "100.00", "100.00"
		}
		if f != want {
			t.Errorf("figures %+v, want %+v", f, want)
		}
	}
	expect(t, "bob's figures of alice's cycle", do(http.MethodGet, "/api/v1/cycles/"+cycle+"/bucket-figures", nil, bob),
		http.StatusNotFound, "not_found")

	// Adjusting and moving funds.
	w = do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/adjustment", map[string]any{"mode": "temporary", "target_funds": "250"}, alice)
	expect(t, "adjust this cycle", w, http.StatusOK, "")
	if u := decode[api.Bucket](t, w); u.TargetFunds != "250.00" {
		t.Errorf("adjusted TF %s, want 250.00", u.TargetFunds)
	}
	expect(t, "adjust, no change", do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/adjustment",
		map[string]any{"mode": "temporary", "target_funds": "250.00"}, alice), http.StatusBadRequest, "no_change")
	expect(t, "adjust, wrong field", do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/adjustment",
		map[string]any{"mode": "both", "target_funds": "1"}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "adjust, unknown mode", do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/adjustment",
		map[string]any{"mode": "weekly", "refill_amount": "1"}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "bob adjusts", do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/adjustment",
		map[string]any{"mode": "future", "refill_amount": "1"}, bob), http.StatusNotFound, "not_found")
	w = do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/transfer", map[string]any{"to_bucket_id": b.Id, "mode": "both", "amount": "50"}, alice)
	expect(t, "move funds, more than the RA", w, http.StatusBadRequest, "invalid_request")
	w = do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/transfer", map[string]any{"to_bucket_id": b.Id, "mode": "temporary", "amount": "50"}, alice)
	expect(t, "move funds", w, http.StatusOK, "")
	if m := decode[struct{ From, To api.Bucket }](t, w); m.From.TargetFunds != "200.00" || m.To.TargetFunds != "50.00" {
		t.Errorf("moved: TF %s and %s, want 200.00 and 50.00", m.From.TargetFunds, m.To.TargetFunds)
	}
	expect(t, "move funds to itself", do(http.MethodPost, "/api/v1/buckets/"+fun.Id+"/transfer",
		map[string]any{"to_bucket_id": fun.Id, "mode": "temporary", "amount": "1"}, alice), http.StatusBadRequest, "invalid_request")

	expect(t, "bob deletes alice's", do(http.MethodDelete, "/api/v1/buckets/"+fun.Id, nil, bob), http.StatusNotFound, "not_found")
	expect(t, "delete", do(http.MethodDelete, "/api/v1/buckets/"+fun.Id, nil, alice), http.StatusNoContent, "")
	expect(t, "get deleted", do(http.MethodGet, "/api/v1/buckets/"+fun.Id, nil, alice), http.StatusNotFound, "not_found")
	if figs := figures(alice); len(figs) != 1 || figs[0].BucketId != b.Id {
		t.Errorf("figures after the delete %+v, want only Groceries", figs)
	}
	w = do(http.MethodGet, "/api/v1/buckets", nil, bob)
	if list := decode[[]api.Bucket](t, w); len(list) != 0 {
		t.Errorf("bob sees %d buckets", len(list))
	}
}
