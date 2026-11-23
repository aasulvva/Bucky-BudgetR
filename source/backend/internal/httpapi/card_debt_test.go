package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestCardDebtAPI: card debt held per account (#261) — a purchase holds its
// bucket parts on the buckets' accounts and the rest where chosen, Set aside
// and Release, a transfer carrying debt, payments clearing and releasing,
// refunds, cash advances, corrections and reversals, and deleting an account
// that holds debt.
func TestCardDebtAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:         auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:     accounts.NewService(pool, l, accounts.Options{Savings: sv}),
		Buckets:      buckets.NewService(pool, l, buckets.Options{ReleaseSavings: sv.ReleaseBucket}),
		Savings:      sv,
		Transactions: transactions.NewService(pool, l, transactions.Options{}),
	})
	user := authtest.NewUser(t, pool, "alice").ID
	alice := authtest.Login(t, h, "alice")
	now := time.Now()
	ledgertest.Cycle(t, pool, user, now.Add(-24*time.Hour), now.Add(30*24*time.Hour), "active")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, alice)
	}
	create := func(body map[string]any) api.Account {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts", body)
		expect(t, "create "+body["name"].(string), w, http.StatusCreated, "")
		return decode[api.Account](t, w)
	}
	get := func(id string) api.Account {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/accounts/"+id, nil)
		expect(t, "get "+id, w, http.StatusOK, "")
		return decode[api.Account](t, w)
	}
	record := func(what string, body map[string]any) api.Transaction {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/transactions", body)
		expect(t, what, w, http.StatusCreated, "")
		return decode[api.Transaction](t, w)
	}
	main := create(map[string]any{"name": "Main", "opening_balance": "10000"})
	spare := create(map[string]any{"name": "Spare", "type": "savings", "opening_balance": "5000"})
	pocket := create(map[string]any{"name": "Pocket", "opening_balance": "50"})
	euro := create(map[string]any{"name": "Euro", "currency": "EUR", "opening_balance": "100"})
	visa := create(map[string]any{"name": "Visa", "type": "credit_card", "opening_balance": "-1000", "credit_card": map[string]any{
		"default_account_id": main.Id, "credit_limit": "20000", "statement_day": 1, "due_day": 15, "minimum_payment": "300",
	}})
	w := do(http.MethodPost, "/api/v1/buckets", map[string]any{"name": "Food", "source_account_id": spare.Id, "opening_funds": "2000"})
	expect(t, "create Food", w, http.StatusCreated, "")
	food := decode[api.Bucket](t, w)
	w = do(http.MethodPost, "/api/v1/buckets", map[string]any{"name": "Trip", "source_account_id": euro.Id, "opening_funds": "50"})
	expect(t, "create Trip", w, http.StatusCreated, "")
	trip := decode[api.Bucket](t, w)

	// The account's holds, by card, and the card's sums.
	holds := func(id string) map[string]string {
		t.Helper()
		out := map[string]string{}
		for _, h := range get(id).CardHolds {
			out[h.CardId] = h.Amount
		}
		return out
	}
	card := func(what, setAside, notSetAside string) {
		t.Helper()
		cc := get(visa.Id).CreditCard.MustGet()
		if cc.SetAside != setAside || cc.NotSetAside != notSetAside {
			t.Errorf("%s: Visa has %s set aside, %s not; want %s and %s", what, cc.SetAside, cc.NotSetAside, setAside, notSetAside)
		}
	}
	card("the opening debt", "0.00", "1000.00")

	// A purchase: the bucket part on the bucket's account, the rest on the
	// default account. The bucket's CAF and TF drop, its account's
	// unallocated money doesn't.
	buy := record("a purchase", map[string]any{"type": "EXP", "account_id": visa.Id, "amount": "500", "counterparty": "Shop",
		"bucket_lines": []map[string]any{{"bucket_id": food.Id, "amount": "300"}}})
	lines := map[string]string{}
	for _, l := range buy.CardLines {
		if l.CardId == visa.Id {
			lines[l.AccountId] = l.Amount
		}
	}
	if len(buy.CardLines) != 2 || lines[main.Id] != "200.00" || lines[spare.Id] != "300.00" {
		t.Fatalf("the purchase's card lines %+v", buy.CardLines)
	}
	if a := get(main.Id); a.Unallocated != "9800.00" || a.CardDebtUncovered != "0.00" {
		t.Errorf("Main after the purchase: %s unallocated, %s not covered", a.Unallocated, a.CardDebtUncovered)
	}
	if a := get(spare.Id); a.Unallocated != "3000.00" || holds(spare.Id)[visa.Id] != "300.00" {
		t.Errorf("Spare after the purchase: %s unallocated, holds %v", a.Unallocated, holds(spare.Id))
	}
	w = do(http.MethodGet, "/api/v1/buckets/"+food.Id, nil)
	expect(t, "Food", w, http.StatusOK, "")
	if b := decode[api.Bucket](t, w); b.TargetFunds != "1700.00" || b.CurrentAvailableFunds != "1700.00" {
		t.Errorf("Food after the purchase: TF %s, CAF %s", b.TargetFunds, b.CurrentAvailableFunds)
	}
	card("after the purchase", "500.00", "1000.00")

	// Set aside nowhere, or somewhere it can't be.
	nowhere := record("not set aside", map[string]any{"type": "EXP", "account_id": visa.Id, "amount": "90", "set_aside_account_id": nil})
	card("not set aside", "500.00", "1090.00")
	// Corrected, it stays set aside nowhere.
	w = do(http.MethodPost, "/api/v1/transactions/"+nowhere.Id+"/correction", map[string]any{"amount": "100"})
	expect(t, "correct a purchase set aside nowhere", w, http.StatusOK, "")
	card("corrected, not set aside", "500.00", "1100.00")
	for what, on := range map[string]string{"on the card": visa.Id, "in euros": euro.Id} {
		expect(t, "set aside "+what, do(http.MethodPost, "/api/v1/transactions",
			map[string]any{"type": "EXP", "account_id": visa.Id, "amount": "1", "set_aside_account_id": on}), http.StatusBadRequest, "card_source")
	}
	expect(t, "a bucket in euros", do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "EXP", "account_id": visa.Id,
		"amount": "10", "bucket_lines": []map[string]any{{"bucket_id": trip.Id, "amount": "10"}}}), http.StatusBadRequest, "invalid_request")
	expect(t, "set aside on a debit purchase", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "EXP", "account_id": main.Id, "amount": "1", "set_aside_account_id": main.Id}), http.StatusBadRequest, "invalid_request")

	// Set aside and Release.
	setAside := "/api/v1/accounts/" + visa.Id + "/card-debt/set-aside"
	release := "/api/v1/accounts/" + visa.Id + "/card-debt/release"
	expect(t, "set aside more than unallocated", do(http.MethodPost, setAside, map[string]any{"account_id": pocket.Id, "amount": "100"}),
		http.StatusConflict, "not_enough_unallocated")
	expect(t, "set aside more than isn't", do(http.MethodPost, setAside, map[string]any{"account_id": main.Id, "amount": "1100.01"}),
		http.StatusBadRequest, "invalid_request")
	expect(t, "set aside for an account", do(http.MethodPost, "/api/v1/accounts/"+main.Id+"/card-debt/set-aside",
		map[string]any{"account_id": spare.Id, "amount": "1"}), http.StatusBadRequest, "invalid_request")
	w = do(http.MethodPost, setAside, map[string]any{"account_id": main.Id, "amount": "1100"})
	expect(t, "set aside", w, http.StatusOK, "")
	if cc := decode[api.Account](t, w).CreditCard.MustGet(); cc.SetAside != "1600.00" || cc.NotSetAside != "0.00" ||
		len(cc.HeldOn) != 2 || cc.HeldOn[0] != (api.CardHeldOn{AccountId: main.Id, Amount: "1300.00"}) {
		t.Errorf("after setting aside %+v", cc)
	}
	if a := get(main.Id); a.Unallocated != "8700.00" {
		t.Errorf("Main after setting aside: %s unallocated", a.Unallocated)
	}
	expect(t, "release more than held", do(http.MethodPost, release, map[string]any{"account_id": spare.Id, "amount": "300.01"}),
		http.StatusConflict, "not_enough_held")
	expect(t, "release", do(http.MethodPost, release, map[string]any{"account_id": main.Id, "amount": "100"}), http.StatusOK, "")
	card("released", "1500.00", "100.00")
	w = do(http.MethodPost, setAside, map[string]any{"account_id": main.Id, "amount": "100"})
	expect(t, "set aside again", w, http.StatusOK, "")
	// It shows on the account's transactions.
	w = do(http.MethodGet, "/api/v1/transactions?account_id="+main.Id+"&type=CDH", nil)
	expect(t, "list CDH", w, http.StatusOK, "")
	if p := decode[api.TransactionPage](t, w); len(p.Items) != 2 {
		t.Errorf("Main's CDH: %d, want 2", len(p.Items))
	}

	// A transfer carries debt only when asked, at most what's held and the
	// amount.
	carry := func(amount, carried string) map[string]any {
		return map[string]any{"type": "TRF", "account_id": spare.Id, "to_account_id": main.Id, "amount": amount,
			"carry_card_debt": []map[string]any{{"card_id": visa.Id, "amount": carried}}}
	}
	expect(t, "carry more than held", do(http.MethodPost, "/api/v1/transactions", carry("400", "300.01")), http.StatusBadRequest, "invalid_request")
	expect(t, "carry more than the amount", do(http.MethodPost, "/api/v1/transactions", carry("200", "300")), http.StatusBadRequest, "invalid_request")
	moved := record("carry", carry("300", "300"))
	if h := holds(spare.Id); len(h) != 0 {
		t.Errorf("Spare after carrying: %v", h)
	}
	if h := holds(main.Id); h[visa.Id] != "1600.00" {
		t.Errorf("Main after carrying: %v", h)
	}
	// A correction keeps what it carries unless told.
	w = do(http.MethodPost, "/api/v1/transactions/"+moved.Id+"/correction", map[string]any{"counterparty": "Moving"})
	expect(t, "correct the counterparty", w, http.StatusOK, "")
	if c := decode[api.Transaction](t, w).CardLines; len(c) != 2 {
		t.Errorf("after correcting the counterparty: %+v", c)
	}
	w = do(http.MethodPost, "/api/v1/transactions/"+moved.Id+"/correction", map[string]any{"carry_card_debt": []any{}})
	expect(t, "carry nothing", w, http.StatusOK, "")
	if c := decode[api.Transaction](t, w).CardLines; len(c) != 0 || holds(spare.Id)[visa.Id] != "300.00" {
		t.Errorf("carrying nothing: %+v, Spare holds %v", c, holds(spare.Id))
	}

	// Payments: the paying account's hold first, then releases as given,
	// or what's held beyond what's owed.
	expect(t, "release past the payment", do(http.MethodPost, "/api/v1/transactions", map[string]any{"type": "TRF", "account_id": pocket.Id,
		"to_account_id": visa.Id, "amount": "10", "release_card_debt": []map[string]any{{"account_id": main.Id, "amount": "11"}}}),
		http.StatusBadRequest, "invalid_request")
	pay := record("a payment", map[string]any{"type": "TRF", "account_id": main.Id, "to_account_id": visa.Id, "amount": "1000"})
	if len(pay.CardLines) != 1 || pay.CardLines[0].Amount != "-1000.00" || holds(main.Id)[visa.Id] != "300.00" {
		t.Errorf("the payment %+v; Main holds %v", pay.CardLines, holds(main.Id))
	}
	record("a payment with releases", map[string]any{"type": "TRF", "account_id": pocket.Id, "to_account_id": visa.Id, "amount": "50",
		"release_card_debt": []map[string]any{{"account_id": main.Id, "amount": "50"}}})
	card("chosen releases", "550.00", "0.00")
	// Paying it all clears Spare's 300 and releases the 250 on Main.
	record("pay it all", map[string]any{"type": "TRF", "account_id": spare.Id, "to_account_id": visa.Id, "amount": "550"})
	card("paid", "0.00", "0.00")
	if h := holds(main.Id); len(h) != 0 {
		t.Errorf("Main after paying it all: %v", h)
	}

	// A refund releases where it's set aside; a cash advance holds on the
	// account the money went to.
	refund := record("a refund", map[string]any{"type": "INC", "account_id": visa.Id, "amount": "50"})
	if h := holds(main.Id); h[visa.Id] != "-50.00" {
		t.Errorf("Main after a refund: %v", h)
	}
	record("a cash advance", map[string]any{"type": "TRF", "account_id": visa.Id, "to_account_id": spare.Id, "amount": "200"})
	if h := holds(spare.Id); h[visa.Id] != "200.00" {
		t.Errorf("Spare after a cash advance: %v", h)
	}
	expect(t, "reverse the refund", do(http.MethodPost, "/api/v1/transactions/"+refund.Id+"/reversal", nil), http.StatusOK, "")
	if h := holds(main.Id); len(h) != 0 {
		t.Errorf("Main after reversing the refund: %v", h)
	}

	// A CDH whose hold has been paid can't be reversed.
	w = do(http.MethodGet, "/api/v1/transactions?account_id="+main.Id+"&type=CDH", nil)
	cdh := decode[api.TransactionPage](t, w).Items[0]
	expect(t, "reverse a paid CDH", do(http.MethodPost, "/api/v1/transactions/"+cdh.Id+"/reversal", nil), http.StatusConflict, "not_enough_held")

	// A correction moves the set-aside part with the amount, where it is.
	w = do(http.MethodPost, "/api/v1/transactions/"+buy.Id+"/correction", map[string]any{"amount": "600"})
	expect(t, "correct the purchase", w, http.StatusOK, "")
	if h := holds(main.Id); h[visa.Id] != "100.00" {
		t.Errorf("Main after correcting the purchase: %v", h)
	}
	// Deleting an account: a transfer carries its holds along, an
	// adjustment releases them.
	old := create(map[string]any{"name": "Old", "opening_balance": "500"})
	record("set aside on Old", map[string]any{"type": "EXP", "account_id": visa.Id, "amount": "40", "set_aside_account_id": old.Id})
	expect(t, "delete Old", do(http.MethodPost, "/api/v1/accounts/"+old.Id+"/delete",
		map[string]any{"remaining_funds": map[string]any{"action": "transfer", "to_account_id": main.Id}}), http.StatusNoContent, "")
	if h := holds(main.Id); h[visa.Id] != "140.00" {
		t.Errorf("Main after Old's deletion: %v", h)
	}
	gone := create(map[string]any{"name": "Gone", "opening_balance": "500"})
	record("set aside on Gone", map[string]any{"type": "EXP", "account_id": visa.Id, "amount": "60", "set_aside_account_id": gone.Id})
	expect(t, "delete Gone", do(http.MethodPost, "/api/v1/accounts/"+gone.Id+"/delete",
		map[string]any{"remaining_funds": map[string]any{"action": "adjust"}}), http.StatusNoContent, "")
	// Owed 400: Main holds 140, Spare 200 from the cash advance.
	card("after deleting Gone", "340.00", "60.00")
}
