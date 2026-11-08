package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func TestCorrectionsAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{}),
		Transactions: transactions.NewService(pool, l, transactions.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	authtest.NewUser(t, pool, "bob")
	alice, bob := authtest.Login(t, h, "alice"), authtest.Login(t, h, "bob")
	do := func(method, path string, body any, c *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, c)
	}

	w := do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Main", "opening_balance": "1000"}, alice)
	expect(t, "create account", w, http.StatusCreated, "")
	main := decode[api.Account](t, w).Id
	w = do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Card"}, alice)
	expect(t, "create card", w, http.StatusCreated, "")
	card := decode[api.Account](t, w).Id

	w = do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "EXP", "account_id": main, "amount": "100", "counterparty": "Rema"}, alice)
	expect(t, "create EXP", w, http.StatusCreated, "")
	exp := decode[api.Transaction](t, w)
	if !exp.Replaces.IsNull() || !exp.ReplacedBy.IsNull() {
		t.Errorf("new transaction %+v", exp)
	}
	path := "/api/v1/transactions/" + exp.Id

	w = do(http.MethodPost, path+"/correction", map[string]any{"amount": "150", "counterparty": "Rema 1000"}, alice)
	expect(t, "correct", w, http.StatusOK, "")
	if got := decode[api.Transaction](t, w); !got.Corrected || got.BankLines[0].Amount != "-150.00" || got.Counterparty != "Rema 1000" ||
		got.History == nil || len(*got.History) != 2 || (*got.History)[1].CorrectionType != api.CorrectionTypeAdjustment {
		t.Errorf("corrected %+v", got)
	}
	expect(t, "no change", do(http.MethodPost, path+"/correction", map[string]any{"amount": "150"}, alice), http.StatusBadRequest, "no_change")
	expect(t, "empty body", do(http.MethodPost, path+"/correction", map[string]any{}, alice), http.StatusBadRequest, "invalid_request")
	expect(t, "bob corrects", do(http.MethodPost, path+"/correction", map[string]any{"amount": "1"}, bob), http.StatusNotFound, "not_found")

	// Move to the card: the response is the new transaction.
	w = do(http.MethodPost, path+"/correction", map[string]any{"account_id": card}, alice)
	expect(t, "move", w, http.StatusOK, "")
	moved := decode[api.Transaction](t, w)
	if moved.Id == exp.Id || moved.Replaces.MustGet() != exp.Id || moved.BankLines[0].AccountId != card || moved.BankLines[0].Amount != "-150.00" {
		t.Errorf("moved %+v", moved)
	}
	w = do(http.MethodGet, path, nil, alice)
	if old := decode[api.Transaction](t, w); !old.Reversed || old.ReplacedBy.MustGet() != moved.Id {
		t.Errorf("old %+v", old)
	}
	expect(t, "correct the reversed one", do(http.MethodPost, path+"/correction", map[string]any{"amount": "1"}, alice), http.StatusConflict, "already_reversed")

	w = do(http.MethodPost, "/api/v1/transactions/"+moved.Id+"/reversal", nil, alice)
	expect(t, "reverse", w, http.StatusOK, "")
	if got := decode[api.Transaction](t, w); !got.Reversed || len(got.BankLines) != 0 ||
		got.BeforeReversal.MustGet().BankLines[0].Amount != "-150.00" {
		t.Errorf("reversed %+v", got)
	}
	if moved.BeforeReversal.IsSpecified() && !moved.BeforeReversal.IsNull() {
		t.Errorf("not reversed, but before_reversal %+v", moved.BeforeReversal)
	}
	expect(t, "reverse twice", do(http.MethodPost, "/api/v1/transactions/"+moved.Id+"/reversal", nil, alice), http.StatusConflict, "already_reversed")

	// Both are reversed now: the moved original and its replacement (#91).
	w = do(http.MethodGet, "/api/v1/transactions?type=EXP&reversed=false", nil, alice)
	expect(t, "not reversed", w, http.StatusOK, "")
	if got := decode[api.TransactionPage](t, w).Items; len(got) != 0 {
		t.Errorf("not reversed %+v", got)
	}
	w = do(http.MethodGet, "/api/v1/transactions?type=EXP&reversed=true", nil, alice)
	if got := decode[api.TransactionPage](t, w).Items; len(got) != 2 {
		t.Errorf("reversed %+v", got)
	}
	expect(t, "reversed=maybe", do(http.MethodGet, "/api/v1/transactions?reversed=maybe", nil, alice), http.StatusBadRequest, "invalid_request")

	// The balance after each (#106): only the opening balance counts on Main;
	// the moved original comes to 0 there.
	w = do(http.MethodGet, "/api/v1/transactions?account_id="+main, nil, alice)
	expect(t, "main's", w, http.StatusOK, "")
	for _, tx := range decode[api.TransactionPage](t, w).Items {
		switch {
		case tx.Type == api.TransactionTypeOPB && (len(tx.BalancesAfter) != 1 || tx.BalancesAfter[0].AccountId != main || tx.BalancesAfter[0].Balance != "1000.00"):
			t.Errorf("opening balance %+v", tx.BalancesAfter)
		case tx.Type != api.TransactionTypeOPB && len(tx.BalancesAfter) != 0:
			t.Errorf("%s %+v", tx.Type, tx.BalancesAfter)
		}
	}
	w = do(http.MethodGet, "/api/v1/transactions", nil, alice)
	if !strings.Contains(w.Body.String(), `"balances_after":[]`) || strings.Contains(w.Body.String(), `"balances_after":[{`) {
		t.Errorf("unfiltered %s", w.Body)
	}

	w = do(http.MethodGet, "/api/v1/accounts/"+main, nil, alice)
	if a := decode[api.Account](t, w); a.Balance != "1000.00" {
		t.Errorf("main balance %s, want 1000.00", a.Balance)
	}
	w = do(http.MethodGet, "/api/v1/accounts/"+card, nil, alice)
	if a := decode[api.Account](t, w); a.Balance != "0.00" {
		t.Errorf("card balance %s, want 0.00", a.Balance)
	}

	// The OPB can be corrected; it's a signed amount.
	w = do(http.MethodGet, "/api/v1/transactions?type=OPB", nil, alice)
	opb := decode[api.TransactionPage](t, w).Items[0]
	w = do(http.MethodPost, "/api/v1/transactions/"+opb.Id+"/correction", map[string]any{"amount": "-50"}, alice)
	expect(t, "correct OPB", w, http.StatusOK, "")
	if got := decode[api.Transaction](t, w); got.BankLines[0].Amount != "-50.00" {
		t.Errorf("OPB %+v", got)
	}
	expect(t, "move OPB", do(http.MethodPost, "/api/v1/transactions/"+opb.Id+"/correction",
		map[string]any{"account_id": card}, alice), http.StatusBadRequest, "invalid_request")
}
