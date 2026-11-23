package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestCreditCardAPI: credit card accounts (#260) — their fields and bill
// account, the limit confirm, the lock when the bill account goes away,
// the type that never changes, no buckets or savings on a card, deleting
// one with debt, and the credit_limit notification.
func TestCreditCardAPI(t *testing.T) {
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	sv := savings.NewService(pool, l, savings.Options{})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:          auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:      accounts.NewService(pool, l, accounts.Options{Savings: sv}),
		Buckets:       buckets.NewService(pool, l, buckets.Options{ReleaseSavings: sv.ReleaseBucket}),
		Savings:       sv,
		Transactions:  transactions.NewService(pool, l, transactions.Options{}),
		Notifications: notifications.NewService(pool, notifications.Options{}),
	})
	authtest.NewUser(t, pool, "alice")
	alice := authtest.Login(t, h, "alice")
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
	main := create(map[string]any{"name": "Main", "opening_balance": "10000"})
	buffer := create(map[string]any{"name": "Buffer", "type": "savings"})
	fund := create(map[string]any{"name": "Fund", "type": "fund"})
	euro := create(map[string]any{"name": "Euro", "currency": "EUR"})
	fields := func(bill string) map[string]any {
		return map[string]any{"bill_account_id": bill, "credit_limit": "20000", "statement_day": 1, "due_day": 15, "minimum_payment": "300"}
	}

	// The fields and the bill account.
	expect(t, "a card without fields", do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Visa", "type": "credit_card"}),
		http.StatusBadRequest, "invalid_request")
	expect(t, "fields on a usage account", do(http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Visa", "credit_card": fields(main.Id)}), http.StatusBadRequest, "invalid_request")
	for what, bill := range map[string]string{"a fund": fund.Id, "another currency": euro.Id, "no such account": "9999"} {
		expect(t, "bill account: "+what, do(http.MethodPost, "/api/v1/accounts",
			map[string]any{"name": "Visa", "type": "credit_card", "credit_card": fields(bill)}), http.StatusBadRequest, "card_bill_account")
	}
	bad := fields(main.Id)
	bad["statement_day"] = 30
	expect(t, "day 30", do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Visa", "type": "credit_card", "credit_card": bad}),
		http.StatusBadRequest, "invalid_request")
	bad = fields(main.Id)
	bad["minimum_payment"] = "0"
	expect(t, "no minimum", do(http.MethodPost, "/api/v1/accounts", map[string]any{"name": "Visa", "type": "credit_card", "credit_card": bad}),
		http.StatusBadRequest, "invalid_request")

	last := fields(main.Id)
	last["statement_day"] = 31
	card := create(map[string]any{"name": "Visa", "type": "credit_card", "opening_balance": "-15000", "credit_card": last})
	cc := card.CreditCard.MustGet()
	if cc.BillAccountId.MustGet() != main.Id || cc.CreditLimit != "20000.00" || cc.StatementDay != 31 || cc.DueDay != 15 ||
		cc.MinimumPayment != "300.00" || cc.Owed != "15000.00" || cc.Available != "5000.00" || cc.Locked {
		t.Fatalf("the card %+v", cc)
	}
	if !main.CreditCard.IsNull() {
		t.Errorf("a usage account has card fields: %+v", main.CreditCard)
	}

	// The limit asks to confirm.
	buy := map[string]any{"type": "EXP", "account_id": card.Id, "amount": "5000.01", "counterparty": "Shop"}
	expect(t, "past the limit", do(http.MethodPost, "/api/v1/transactions", buy), http.StatusConflict, "over_credit_limit")
	buy["amount"] = "4000"
	w := do(http.MethodPost, "/api/v1/transactions", buy)
	expect(t, "within the limit", w, http.StatusCreated, "")
	tx := decode[api.Transaction](t, w)
	expect(t, "corrected past the limit", do(http.MethodPost, "/api/v1/transactions/"+tx.Id+"/correction", map[string]any{"amount": "5000.01"}),
		http.StatusConflict, "over_credit_limit")
	expect(t, "corrected and confirmed", do(http.MethodPost, "/api/v1/transactions/"+tx.Id+"/correction",
		map[string]any{"amount": "5000.01", "limit_confirmed": true}), http.StatusOK, "")
	// Already past it, a payment that lowers the debt passes, and so does
	// a correction that lowers it.
	expect(t, "a payment past the limit", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "TRF", "account_id": main.Id, "to_account_id": card.Id, "amount": "1000"}), http.StatusCreated, "")

	// The notification: past the limit, then near it.
	notes := func() []api.Notification {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/notifications", nil)
		expect(t, "notifications", w, http.StatusOK, "")
		var out []api.Notification
		for _, n := range decode[api.NotificationList](t, w).Items {
			if n.Kind == api.NotificationKindCreditLimit {
				out = append(out, n)
			}
		}
		return out
	}
	if n := notes(); len(n) != 1 || n[0].Severity != api.NotificationSeverityWarning || n[0].AccountId.MustGet() != card.Id ||
		n[0].Amount.MustGet() != "19000.01" || n[0].Key != "card-limit:"+card.Id+":90" {
		t.Fatalf("near the limit: %+v", n)
	}
	expect(t, "over again", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "EXP", "account_id": card.Id, "amount": "3000", "limit_confirmed": true}), http.StatusCreated, "")
	if n := notes(); len(n) != 1 || n[0].Severity != api.NotificationSeverityAlert || n[0].Key != "card-limit:"+card.Id+":100" {
		t.Fatalf("past the limit: %+v", n)
	}

	// No type changes, no expected income.
	expect(t, "card to usage", do(http.MethodPatch, "/api/v1/accounts/"+card.Id, map[string]any{"type": "usage"}),
		http.StatusBadRequest, "card_type")
	expect(t, "usage to card", do(http.MethodPatch, "/api/v1/accounts/"+buffer.Id, map[string]any{"type": "credit_card"}),
		http.StatusBadRequest, "card_type")
	expect(t, "expected income", do(http.MethodPatch, "/api/v1/accounts/"+card.Id, map[string]any{"expected_income": "100"}),
		http.StatusBadRequest, "invalid_request")
	expect(t, "card fields on another account", do(http.MethodPatch, "/api/v1/accounts/"+buffer.Id, map[string]any{"credit_card": fields(main.Id)}),
		http.StatusBadRequest, "invalid_request")

	// No buckets or savings on a card.
	expect(t, "a bucket on a card", do(http.MethodPost, "/api/v1/buckets",
		map[string]any{"name": "Fun", "source_account_id": card.Id, "refill_amount": "100", "cap_multiplier": "1"}),
		http.StatusBadRequest, "card_source")
	expect(t, "the distributor from a card", do(http.MethodPost, "/api/v1/savings/distributor/add",
		map[string]any{"account_id": card.Id, "amount": "1"}), http.StatusBadRequest, "card_source")

	// A bill account that changes to a type that can't be one locks the
	// card; a new bill account unlocks it.
	w = do(http.MethodPatch, "/api/v1/accounts/"+card.Id, map[string]any{"credit_card": fields(buffer.Id)})
	expect(t, "move the bill to the buffer", w, http.StatusOK, "")
	expect(t, "the buffer becomes a fund", do(http.MethodPatch, "/api/v1/accounts/"+buffer.Id, map[string]any{"type": "fund"}), http.StatusOK, "")
	w = do(http.MethodGet, "/api/v1/accounts/"+card.Id, nil)
	if cc := decode[api.Account](t, w).CreditCard.MustGet(); !cc.Locked || !cc.BillAccountId.IsNull() {
		t.Fatalf("locked %+v", cc)
	}
	expect(t, "a purchase on a locked card", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "EXP", "account_id": card.Id, "amount": "1", "limit_confirmed": true}), http.StatusConflict, "card_locked")
	expect(t, "a payment to a locked card", do(http.MethodPost, "/api/v1/transactions",
		map[string]any{"type": "TRF", "account_id": main.Id, "to_account_id": card.Id, "amount": "1"}), http.StatusConflict, "card_locked")
	expect(t, "adjusting a locked card", do(http.MethodPost, "/api/v1/accounts/"+card.Id+"/balance-adjustment",
		map[string]any{"target_balance": "0"}), http.StatusConflict, "card_locked")
	expect(t, "correcting on a locked card", do(http.MethodPost, "/api/v1/transactions/"+tx.Id+"/correction",
		map[string]any{"amount": "10"}), http.StatusConflict, "card_locked")
	expect(t, "a new bill account", do(http.MethodPatch, "/api/v1/accounts/"+card.Id, map[string]any{"credit_card": fields(main.Id)}),
		http.StatusOK, "")

	// Deleting the bill account locks the card too.
	other := create(map[string]any{"name": "Other"})
	expect(t, "bill from other", do(http.MethodPatch, "/api/v1/accounts/"+card.Id, map[string]any{"credit_card": fields(other.Id)}), http.StatusOK, "")
	expect(t, "delete other", do(http.MethodPost, "/api/v1/accounts/"+other.Id+"/delete", map[string]any{}), http.StatusNoContent, "")
	w = do(http.MethodGet, "/api/v1/accounts/"+card.Id, nil)
	if cc := decode[api.Account](t, w).CreditCard.MustGet(); !cc.Locked {
		t.Fatalf("not locked after its bill account was deleted: %+v", cc)
	}

	// A card with debt, even a locked one, is deleted by paying it off from
	// another account.
	expect(t, "delete with debt", do(http.MethodPost, "/api/v1/accounts/"+card.Id+"/delete", map[string]any{}), http.StatusConflict, "balance_not_zero")
	expect(t, "delete, paid off from main", do(http.MethodPost, "/api/v1/accounts/"+card.Id+"/delete",
		map[string]any{"remaining_funds": map[string]any{"action": "transfer", "to_account_id": main.Id}}), http.StatusNoContent, "")
	w = do(http.MethodGet, "/api/v1/accounts/"+main.Id, nil)
	// 10 000 − 1 000 paid, − 22 000.01 left on the card.
	if got := decode[api.Account](t, w).Balance; got != "-13000.01" {
		t.Errorf("main after paying off the card: %s", got)
	}
}
