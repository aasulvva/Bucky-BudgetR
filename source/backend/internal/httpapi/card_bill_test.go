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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/httpapi"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestCardBillAPI: a credit card's bill (#262) — a card from before is
// locked until set up; the setup's statement; payments; the notifications
// as the due date comes and goes; a live statement that counts a purchase
// entered late, until it's checked against the bank; a differing bank
// amount adjusting the card; and statements fixed once they're due.
func TestCardBillAPI(t *testing.T) {
	pool := testdb.New(t)
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	acc := accounts.NewService(pool, l, accounts.Options{Now: clock})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:          auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:      acc,
		Transactions:  transactions.NewService(pool, l, transactions.Options{Now: clock}),
		Notifications: notifications.NewService(pool, notifications.Options{Now: clock}),
	})
	authtest.NewUser(t, pool, "alice")
	alice := authtest.Login(t, h, "alice")
	do := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return authtest.Do(t, h, method, path, body, alice)
	}
	expect(t, "time zone", do(http.MethodPatch, "/api/v1/me/preferences", map[string]any{"time_zone": "Europe/Oslo"}),
		http.StatusOK, "")
	create := func(body map[string]any) api.Account {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts", body)
		expect(t, "create "+body["name"].(string), w, http.StatusCreated, "")
		return decode[api.Account](t, w)
	}
	main := create(map[string]any{"name": "Main", "opening_balance": "10000"})
	fields := map[string]any{"credit_limit": "20000", "statement_day": 1, "due_day": 15, "minimum_payment": "300",
		"default_account_id": main.Id}
	visa := create(map[string]any{"name": "Visa", "type": "credit_card", "credit_card": fields,
		"opening_balance": "-4520", "opening_at": "2026-10-20T12:00:00Z"})
	bill := func(id string) api.CardBill {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/accounts/"+id+"/bill", nil)
		expect(t, "bill", w, http.StatusOK, "")
		return decode[api.CardBill](t, w)
	}
	pay := func(from, to, amount string) {
		t.Helper()
		expect(t, "pay "+amount, do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "TRF", "account_id": from, "to_account_id": to, "amount": amount,
		}), http.StatusCreated, "")
	}
	cardNotes := func() []api.Notification {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/notifications", nil)
		expect(t, "notifications", w, http.StatusOK, "")
		var out []api.Notification
		for _, n := range decode[api.NotificationList](t, w).Items {
			switch n.Kind {
			case api.NotificationKindCardBill, api.NotificationKindCardBillDue, api.NotificationKindCardBillCarried:
				out = append(out, n)
			}
		}
		return out
	}
	oneNote := func(what string, kind api.NotificationKind, left, minimum string) {
		t.Helper()
		got := cardNotes()
		if len(got) != 1 || got[0].Kind != kind || got[0].Amount.MustGet() != left || got[0].Minimum.MustGet() != minimum ||
			got[0].AccountId.MustGet() != visa.Id {
			t.Fatalf("%s: notifications %+v", what, got)
		}
	}

	// Not a card, or none.
	expect(t, "a usage account's bill", do(http.MethodGet, "/api/v1/accounts/"+main.Id+"/bill", nil),
		http.StatusBadRequest, "not_a_card")
	expect(t, "no such account", do(http.MethodGet, "/api/v1/accounts/9999/bill", nil), http.StatusNotFound, "not_found")
	expect(t, "a last statement on a usage account", do(http.MethodPost, "/api/v1/accounts", map[string]any{
		"name": "Other", "last_statement": map[string]any{"amount": "1", "paid": "0"},
	}), http.StatusBadRequest, "invalid_request")

	// A new card's bill starts at the next statement day.
	if b := bill(visa.Id); !b.SetUp || !b.Current.IsNull() || b.NextStatementDate.String() != "2026-12-01" {
		t.Fatalf("a new card's bill %+v", b)
	}
	// A card from before #262 is locked until set up.
	if _, err := pool.Exec(t.Context(), `UPDATE bank_accounts SET card_bill_set_up_at = NULL WHERE id = $1`, visa.Id); err != nil {
		t.Fatal(err)
	}
	if b := bill(visa.Id); b.SetUp || !b.Current.IsNull() {
		t.Fatalf("a locked bill %+v", b)
	}
	expect(t, "finalize before the setup", do(http.MethodPost, "/api/v1/accounts/"+visa.Id+"/bill/finalize",
		map[string]any{"amount": "1", "payment": nil}), http.StatusConflict, "bill_not_set_up")
	if n := cardNotes(); len(n) != 0 {
		t.Fatalf("notifications before the setup %+v", n)
	}
	setup := func(last any) *httptest.ResponseRecorder {
		return do(http.MethodPost, "/api/v1/accounts/"+visa.Id+"/bill/setup", map[string]any{"last_statement": last})
	}
	expect(t, "a negative statement", setup(map[string]any{"amount": "-1", "paid": "0"}), http.StatusBadRequest, "")
	w := setup(map[string]any{"amount": "3000", "paid": "500"})
	expect(t, "setup", w, http.StatusOK, "")
	cur := decode[api.CardBill](t, w).Current.MustGet()
	if cur.Id != visa.Id+"20261101" || !cur.Fixed || cur.FixedBy.MustGet() != api.CardStatementFixedBySetup ||
		cur.Amount != "3000.00" || cur.Minimum != "300.00" || cur.Paid != "500.00" || cur.Left != "2500.00" ||
		cur.MinimumLeft != "0.00" || cur.DueDate.String() != "2026-11-15" ||
		!cur.Cutoff.Equal(time.Date(2026, 10, 31, 23, 0, 0, 0, time.UTC)) {
		t.Fatalf("the setup's statement %+v", cur)
	}
	expect(t, "setup twice", setup(nil), http.StatusConflict, "bill_set_up")

	// Payments count; the notification moves on with the due date.
	pay(main.Id, visa.Id, "1000")
	oneNote("ready", api.NotificationKindCardBill, "1500.00", "0.00")
	now = time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	oneNote("due soon", api.NotificationKindCardBillDue, "1500.00", "0.00")
	now = time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	oneNote("carried over", api.NotificationKindCardBillCarried, "1500.00", "0.00")
	expect(t, "switched off", do(http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"notifications": map[string]any{"card_bills": false}}), http.StatusOK, "")
	if n := cardNotes(); len(n) != 0 {
		t.Fatalf("switched off %+v", n)
	}
	expect(t, "switched on", do(http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"notifications": map[string]any{"card_bills": true}}), http.StatusOK, "")

	// The next statement is worked out: a purchase entered late but dated
	// before the cutoff counts, until it's checked against the bank.
	now = time.Date(2026, 12, 2, 10, 0, 0, 0, time.UTC)
	purchase := func(amount, at string) {
		t.Helper()
		expect(t, "purchase "+amount, do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "EXP", "account_id": visa.Id, "amount": amount, "at": at, "counterparty": "Shop",
		}), http.StatusCreated, "")
	}
	b := bill(visa.Id)
	cur = b.Current.MustGet()
	if cur.Fixed || cur.Amount != "3520.00" || cur.Paid != "0.00" || cur.DueDate.String() != "2026-12-15" ||
		b.Previous.MustGet().Id != visa.Id+"20261101" || b.Previous.MustGet().Paid != "1500.00" {
		t.Fatalf("the December statement %+v", b)
	}
	purchase("100", "2026-11-30T22:30:00Z") // 23:30 in Oslo
	purchase("40", "2026-11-30T23:30:00Z")  // after the cutoff
	if cur = bill(visa.Id).Current.MustGet(); cur.Amount != "3620.00" {
		t.Fatalf("a late purchase %+v", cur)
	}
	// The account list has the bill too.
	w = do(http.MethodGet, "/api/v1/accounts/"+visa.Id, nil)
	if got := decode[api.Account](t, w).CreditCard.MustGet().Bill.Current.MustGet(); got.Amount != "3620.00" {
		t.Fatalf("the card's bill %+v", got)
	}
	w = do(http.MethodPost, "/api/v1/accounts/"+visa.Id+"/bill/finalize", map[string]any{"amount": "3620", "payment": nil})
	expect(t, "it matches the bank", w, http.StatusOK, "")
	if cur = decode[api.CardBillFinalized](t, w).Bill.Current.MustGet(); !cur.Fixed || cur.FixedBy.MustGet() != api.CardStatementFixedByBank {
		t.Fatalf("checked %+v", cur)
	}
	purchase("50", "2026-11-29T12:00:00Z")
	if cur = bill(visa.Id).Current.MustGet(); cur.Amount != "3620.00" {
		t.Fatalf("a fixed statement changed %+v", cur)
	}
	expect(t, "finalize twice", do(http.MethodPost, "/api/v1/accounts/"+visa.Id+"/bill/finalize", map[string]any{"amount": "3620", "payment": nil}),
		http.StatusConflict, "statement_fixed")

	// A card created with its last statement; a bank amount that differs
	// adjusts what it owed at the cutoff.
	amex := create(map[string]any{"name": "Amex", "type": "credit_card", "credit_card": fields, "opening_balance": "-1200",
		"last_statement": map[string]any{"amount": "1000", "paid": "0"}})
	if cur = bill(amex.Id).Current.MustGet(); cur.Id != amex.Id+"20261201" || cur.FixedBy.MustGet() != api.CardStatementFixedBySetup ||
		cur.Amount != "1000.00" {
		t.Fatalf("a new card's last statement %+v", cur)
	}
	now = time.Date(2027, 1, 2, 10, 0, 0, 0, time.UTC)
	if cur = bill(amex.Id).Current.MustGet(); cur.Fixed || cur.Amount != "1200.00" {
		t.Fatalf("Amex in January %+v", cur)
	}
	w = do(http.MethodPost, "/api/v1/accounts/"+amex.Id+"/bill/finalize", map[string]any{"amount": "1250", "payment": nil})
	expect(t, "a differing bank amount", w, http.StatusOK, "")
	if cur = decode[api.CardBillFinalized](t, w).Bill.Current.MustGet(); !cur.Fixed || cur.Amount != "1250.00" {
		t.Fatalf("adjusted %+v", cur)
	}
	var bla time.Time
	if err := pool.QueryRow(t.Context(), `SELECT h.transaction_at FROM transaction_headers h
		JOIN bank_transactions l ON l.transaction_id = h.id
		WHERE l.account_id = $1 AND h.transaction_type = 'BLA'`, amex.Id).Scan(&bla); err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 12, 31, 23, 0, 0, 0, time.UTC).Add(-time.Microsecond); !bla.Equal(want) {
		t.Errorf("the adjustment is at %s, want %s", bla, want)
	}
	if got := decode[api.Account](t, do(http.MethodGet, "/api/v1/accounts/"+amex.Id, nil)).Balance; got != "-1250.00" {
		t.Errorf("Amex's balance %s", got)
	}

	// Once the due date has passed, the loop fixes the statement.
	now = time.Date(2027, 1, 16, 10, 0, 0, 0, time.UTC)
	if err := acc.RunBills(t.Context(), discard()); err != nil {
		t.Fatal(err)
	}
	var by string
	if err := pool.QueryRow(t.Context(), `SELECT fixed_by::text FROM card_statements WHERE id = $1`, visa.Id+"20270101").Scan(&by); err != nil || by != "due" {
		t.Fatalf("Visa's January statement: %q, %v", by, err)
	}
	if cur = bill(visa.Id).Current.MustGet(); !cur.Fixed || cur.FixedBy.MustGet() != api.CardStatementFixedByDue {
		t.Fatalf("fixed when due %+v", cur)
	}
}
