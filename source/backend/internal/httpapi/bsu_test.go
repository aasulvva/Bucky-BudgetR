package httpapi_test

import (
	"context"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// BSU accounts (#214): NOK only, the history setup, the confirm on
// transactions, and the admins' rules with their audit entries.
func TestBSUAPI(t *testing.T) {
	pool := testdb.New(t)
	store := logging.NewStore(slog.DiscardHandler)
	logger := store.Logger()
	store.Start(sqlc.New(pool))
	l := ledger.New(ledger.Options{})
	h := newHandler(t, logger, pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{}),
		Transactions: transactions.NewService(pool, l, transactions.Options{}),
		BSU:          bsu.NewService(pool, l, bsu.Options{}),
		Logs:         logging.NewService(pool, logger),
	})
	authtest.NewUser(t, pool, "admin", authtest.Admin)
	authtest.NewUser(t, pool, "alice")
	admin := authtest.Login(t, h, "admin")
	alice := authtest.Login(t, h, "alice")
	this := bsu.Year(time.Now())

	w := authtest.Do(t, h, http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Euro BSU", "type": "bsu", "currency": "EUR"}, alice)
	expect(t, "a EUR BSU", w, http.StatusBadRequest, "bsu_currency")
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "50000"}, alice)
	expect(t, "main", w, http.StatusCreated, "")
	main := decode[api.Account](t, w)
	if main.Bsu.IsSpecified() && !main.Bsu.IsNull() {
		t.Errorf("a usage account has a BSU status: %+v", main.Bsu)
	}
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/accounts", map[string]any{"name": "BSU", "type": "bsu", "opening_balance": "1000"}, alice)
	expect(t, "a BSU", w, http.StatusCreated, "")
	acc := decode[api.Account](t, w)
	st := acc.Bsu.MustGet()
	if !st.Locked || st.Year != this || st.YearlyLimit != "27500.00" || st.LeftYear != "27500.00" || !st.OpenedYear.IsNull() {
		t.Fatalf("a new BSU's status %+v", st)
	}

	w = authtest.Do(t, h, http.MethodGet, "/api/v1/accounts/"+main.Id+"/bsu-history", nil, alice)
	expect(t, "a usage account's history", w, http.StatusBadRequest, "not_bsu")
	w = authtest.Do(t, h, http.MethodGet, "/api/v1/accounts/"+acc.Id+"/bsu-history", nil, alice)
	expect(t, "history", w, http.StatusOK, "")
	hist := decode[api.BSUHistory](t, w)
	if hist.LatestOpenedYear != this || len(hist.Years) != 1 || hist.Opening != "1000.00" || hist.Balance != "1000.00" ||
		!hist.SetUpAt.IsNull() || len(hist.Rules) != 1 {
		t.Fatalf("history %+v", hist)
	}

	year := func(y int, deposits string) map[string]any {
		return map[string]any{"year": y, "deposits": deposits, "interest": "0", "withdrawals": "0"}
	}
	setUp := map[string]any{"opened_year": this - 1, "years": []any{year(this-1, "27500"), year(this, "20000")}, "balance": "47500"}
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/accounts/"+acc.Id+"/bsu-history",
		map[string]any{"opened_year": this - 1, "years": []any{year(this-1, "27500")}, "balance": "47500"}, alice)
	expect(t, "a year missing", w, http.StatusBadRequest, "invalid_request")
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/accounts/"+acc.Id+"/bsu-history", setUp, alice)
	expect(t, "set up", w, http.StatusOK, "")
	st = decode[api.Account](t, w).Bsu.MustGet()
	if st.Locked || st.DepositedYear != "20000.00" || st.DepositedTotal != "47500.00" || st.LeftYear != "7500.00" || st.OpenedYear.MustGet() != this-1 {
		t.Fatalf("set up %+v", st)
	}
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/accounts/"+acc.Id+"/bsu-history", setUp, alice)
	expect(t, "again", w, http.StatusConflict, "bsu_set_up")
	w = authtest.Do(t, h, http.MethodGet, "/api/v1/accounts/"+acc.Id+"/bsu-history", nil, alice)
	hist = decode[api.BSUHistory](t, w)
	if at, err := hist.SetUpAt.Get(); err != nil || at.Location() != time.UTC {
		t.Errorf("set up at %v %v, want UTC", at, err)
	}

	// Over the limit, and withdrawals, ask first.
	trf := map[string]any{"type": "TRF", "account_id": main.Id, "to_account_id": acc.Id, "amount": "8000"}
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/transactions", trf, alice)
	expect(t, "over the limit", w, http.StatusConflict, "bsu_over_limit")
	trf["bsu_confirmed"] = true
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/transactions", trf, alice)
	expect(t, "confirmed", w, http.StatusCreated, "")
	exp := map[string]any{"type": "EXP", "account_id": acc.Id, "amount": "100"}
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/transactions", exp, alice)
	expect(t, "a withdrawal", w, http.StatusConflict, "bsu_withdrawal")
	exp["bsu_confirmed"] = true
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/transactions", exp, alice)
	expect(t, "a confirmed withdrawal", w, http.StatusCreated, "")
	tr := decode[api.Transaction](t, w)
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/transactions/"+tr.Id+"/correction", map[string]any{"amount": "200"}, alice)
	expect(t, "correcting a withdrawal up", w, http.StatusConflict, "bsu_withdrawal")
	w = authtest.Do(t, h, http.MethodPost, "/api/v1/transactions/"+tr.Id+"/correction", map[string]any{"amount": "200", "bsu_confirmed": true}, alice)
	expect(t, "confirmed", w, http.StatusOK, "")

	// The rules are the admins'.
	w = authtest.Do(t, h, http.MethodGet, "/api/v1/admin/bsu-rules", nil, alice)
	expect(t, "rules as a user", w, http.StatusForbidden, "")
	w = authtest.Do(t, h, http.MethodPut, "/api/v1/admin/bsu-rules/2030", map[string]any{"yearly_limit": "30000", "total_limit": "350000"}, alice)
	expect(t, "a rule as a user", w, http.StatusForbidden, "")
	w = authtest.Do(t, h, http.MethodPut, "/api/v1/admin/bsu-rules/2030", map[string]any{"yearly_limit": "30000", "total_limit": "20000"}, admin)
	expect(t, "total below yearly", w, http.StatusBadRequest, "invalid_request")
	w = authtest.Do(t, h, http.MethodPut, "/api/v1/admin/bsu-rules/2030", map[string]any{"yearly_limit": "30000", "total_limit": "350000"}, admin)
	expect(t, "a new rule", w, http.StatusOK, "")
	if r := decode[api.BSURule](t, w); r.FromYear != 2030 || r.YearlyLimit != "30000.00" || r.ModifiedAt.Location() != time.UTC {
		t.Errorf("rule %+v", r)
	}
	w = authtest.Do(t, h, http.MethodPut, "/api/v1/admin/bsu-rules/2030", map[string]any{"yearly_limit": "32000", "total_limit": "350000"}, admin)
	expect(t, "a changed rule", w, http.StatusOK, "")
	w = authtest.Do(t, h, http.MethodGet, "/api/v1/admin/bsu-rules", nil, admin)
	expect(t, "rules", w, http.StatusOK, "")
	if list := decode[[]api.BSURule](t, w); len(list) != 2 || list[1].YearlyLimit != "32000.00" {
		t.Errorf("rules %+v", list)
	}
	w = authtest.Do(t, h, http.MethodDelete, "/api/v1/admin/bsu-rules/2030", nil, admin)
	expect(t, "delete", w, http.StatusNoContent, "")
	w = authtest.Do(t, h, http.MethodDelete, "/api/v1/admin/bsu-rules/2021", nil, admin)
	expect(t, "the last rule", w, http.StatusConflict, "last_rule")
	w = authtest.Do(t, h, http.MethodDelete, "/api/v1/admin/bsu-rules/2030", nil, admin)
	expect(t, "a missing rule", w, http.StatusNotFound, "not_found")

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := store.Close(ctx); err != nil {
		t.Fatal(err)
	}
	w = authtest.Do(t, h, http.MethodGet, "/api/v1/admin/logs?kind=audit", nil, admin)
	expect(t, "audit", w, http.StatusOK, "")
	page := decode[api.LogPage](t, w)
	var events []string
	for _, e := range page.Entries {
		events = append(events, deref(e.Event))
	}
	if len(events) != 3 || events[0] != "bsu.rule_deleted" || events[1] != "bsu.rule_changed" || events[2] != "bsu.rule_changed" {
		t.Fatalf("audit events %v", events)
	}
	if a := page.Entries[1].Attrs; a["old.yearly_limit"] != "30000.00" || a["new.yearly_limit"] != "32000.00" || a["from_year"] != float64(2030) {
		t.Errorf("changed attrs %v", a)
	}
}
