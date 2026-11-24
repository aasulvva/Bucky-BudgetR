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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// TestCardBillPayments: finalizing a card's bill with its payment (#262) —
// asked first and queued at once, paying what's left when approved after a
// payment by hand; a scheduled minimum skipped once it's all paid; paying a
// fixed amount now, at most what's left; the card's pay defaults; and
// auto-finalize on the payment day, paying at once or asking first.
func TestCardBillPayments(t *testing.T) {
	pool := testdb.New(t)
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	tx := transactions.NewService(pool, l, transactions.Options{Now: clock})
	sch := schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx})
	acc := accounts.NewService(pool, l, accounts.Options{Now: clock, Transactions: tx, Schedules: sch})
	h := newHandler(t, discard(), pool, httpapi.Options{
		Auth:          auth.NewService(pool, discard(), auth.Options{IdleTimeout: idle, MaxAge: maxAge}),
		Accounts:      acc,
		Transactions:  tx,
		Schedules:     sch,
		Notifications: notifications.NewService(pool, notifications.Options{Now: clock, Schedules: sch}),
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
	main := create(map[string]any{"name": "Main", "opening_balance": "20000", "opening_at": "2026-10-01T12:00:00Z"})
	fields := map[string]any{"credit_limit": "20000", "statement_day": 1, "due_day": 15, "minimum_payment": "300",
		"default_account_id": main.Id}
	visa := create(map[string]any{"name": "Visa", "type": "credit_card", "credit_card": fields,
		"opening_balance": "-4520", "opening_at": "2026-10-20T12:00:00Z"})
	if p := visa.CreditCard.MustGet().Pay; p.Rule != api.CardPayRuleFull || p.Mode != api.ScheduleModeApprove ||
		p.DaysBefore != 0 || p.AutoFinalize || !p.Amount.IsNull() {
		t.Fatalf("a new card's pay defaults %+v", p)
	}
	bill := func() api.CardBill {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/accounts/"+visa.Id+"/bill", nil)
		expect(t, "bill", w, http.StatusOK, "")
		return decode[api.CardBill](t, w)
	}
	transfer := func(amount string) {
		t.Helper()
		expect(t, "pay "+amount, do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "TRF", "account_id": main.Id, "to_account_id": visa.Id, "amount": amount,
		}), http.StatusCreated, "")
	}
	purchase := func(amount, at string) {
		t.Helper()
		expect(t, "purchase "+amount, do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "EXP", "account_id": visa.Id, "amount": amount, "at": at, "counterparty": "Shop",
		}), http.StatusCreated, "")
	}
	finalize := func(what string, amount string, payment any, status int, code string) api.CardBillFinalized {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts/"+visa.Id+"/bill/finalize", map[string]any{"amount": amount, "payment": payment})
		expect(t, what, w, status, code)
		if status != http.StatusOK {
			return api.CardBillFinalized{}
		}
		return decode[api.CardBillFinalized](t, w)
	}
	queued := func() []api.ScheduledTransaction {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/scheduled-transactions?state=queued", nil)
		expect(t, "queued", w, http.StatusOK, "")
		return decode[api.ScheduledTransactionPage](t, w).Items
	}
	scheduleAmount := func(id string) string {
		t.Helper()
		w := do(http.MethodGet, "/api/v1/schedules/"+id, nil)
		expect(t, "schedule", w, http.StatusOK, "")
		return decode[api.Schedule](t, w).Transaction.Amount
	}
	cardNotes := func() int {
		t.Helper()
		n := 0
		for _, x := range decode[api.NotificationList](t, do(http.MethodGet, "/api/v1/notifications", nil)).Items {
			switch x.Kind {
			case api.NotificationKindCardBill, api.NotificationKindCardBillDue, api.NotificationKindCardBillCarried:
				n++
			}
		}
		return n
	}

	// December: ask first, queued at once, due at its time.
	now = time.Date(2026, 12, 2, 10, 0, 0, 0, time.UTC)
	finalize("from a card", "4520", map[string]any{"rule": "full", "account_id": visa.Id, "mode": "approve"},
		http.StatusBadRequest, "invalid_request")
	finalize("a fixed amount without one", "4520", map[string]any{"rule": "fixed", "account_id": main.Id, "mode": "approve"},
		http.StatusBadRequest, "invalid_request")
	if n := cardNotes(); n != 1 {
		t.Fatalf("before finalizing: %d card notifications", n)
	}
	due := "2026-12-15T07:00:00Z" // 08:00 in Oslo
	done := finalize("ask first", "4520", map[string]any{"rule": "full", "account_id": main.Id, "mode": "approve", "at": due},
		http.StatusOK, "")
	scheduleID := done.ScheduleId.MustGet()
	if p := done.Bill.Payment.MustGet(); p.State != api.CardBillPaymentStateQueued || p.Amount != "4520.00" ||
		p.ScheduleId != scheduleID || p.AccountId != main.Id || !done.Bill.Current.MustGet().Fixed {
		t.Fatalf("the finalized bill %+v", done.Bill)
	}
	q := queued()
	if len(q) != 1 || q[0].ScheduleId != scheduleID || q[0].DueAt.MustGet().Format(time.RFC3339) != due {
		t.Fatalf("queued %+v", q)
	}
	if n := cardNotes(); n != 0 {
		t.Errorf("with a payment queued: %d card notifications", n)
	}
	finalize("twice", "4520", nil, http.StatusConflict, "statement_fixed")
	// Paid partly by hand: approving pays what's left.
	transfer("1000")
	if a := scheduleAmount(scheduleID); a != "3520.00" {
		t.Errorf("the schedule pays %s, want 3520.00", a)
	}
	w := do(http.MethodPost, "/api/v1/scheduled-transactions/"+q[0].Id+"/approve", nil)
	expect(t, "approve", w, http.StatusOK, "")
	b := bill()
	if cur := b.Current.MustGet(); cur.Left != "0.00" || cur.Paid != "4520.00" ||
		b.Payment.MustGet().State != api.CardBillPaymentStateApplied {
		t.Fatalf("after approving %+v", b)
	}

	// January: the minimum, scheduled; paid in full by hand, it's skipped.
	now = time.Date(2026, 12, 11, 10, 0, 0, 0, time.UTC)
	purchase("600", "2026-12-10T12:00:00Z")
	now = time.Date(2027, 1, 2, 10, 0, 0, 0, time.UTC)
	at := "2027-01-14T07:00:00Z"
	done = finalize("the minimum, auto", "600", map[string]any{"rule": "minimum", "account_id": main.Id, "mode": "auto", "at": at},
		http.StatusOK, "")
	if p := done.Bill.Payment.MustGet(); p.State != api.CardBillPaymentStateScheduled || p.Amount != "300.00" || p.Mode != api.ScheduleModeAuto {
		t.Fatalf("the scheduled minimum %+v", p)
	}
	transfer("600")
	if a := scheduleAmount(done.ScheduleId.MustGet()); a != "0.00" {
		t.Errorf("the paid schedule pays %s", a)
	}
	now = time.Date(2027, 1, 14, 8, 0, 0, 0, time.UTC)
	if err := sch.RunDue(t.Context(), discard()); err != nil {
		t.Fatal(err)
	}
	if p := bill().Payment.MustGet(); p.State != api.CardBillPaymentStateSkipped || p.Reason.MustGet() != "paid" {
		t.Fatalf("a paid minimum %+v", p)
	}

	// February: a fixed amount now pays at most what's left.
	now = time.Date(2027, 1, 21, 10, 0, 0, 0, time.UTC)
	purchase("200", "2027-01-20T12:00:00Z")
	now = time.Date(2027, 2, 2, 10, 0, 0, 0, time.UTC)
	done = finalize("pay now", "200", map[string]any{"rule": "fixed", "amount": "500", "account_id": main.Id, "mode": "auto"},
		http.StatusOK, "")
	if done.TransactionId.IsNull() || !done.ScheduleId.IsNull() || done.Bill.Current.MustGet().Left != "0.00" {
		t.Fatalf("paid now %+v", done)
	}
	got := decode[api.Transaction](t, do(http.MethodGet, "/api/v1/transactions/"+done.TransactionId.MustGet(), nil))
	for _, l := range got.BankLines {
		if l.AccountId == visa.Id && l.Amount != "200.00" {
			t.Errorf("paid %s, want 200.00", l.Amount)
		}
	}

	// The defaults: auto-finalize needs the default account.
	pay := map[string]any{"rule": "full", "days_before": 2, "mode": "auto", "auto_finalize": true}
	noDefault := map[string]any{"credit_limit": "5000", "statement_day": 1, "due_day": 15, "minimum_payment": "100", "pay": pay}
	expect(t, "auto-finalize without a default account", do(http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Amex", "type": "credit_card", "credit_card": noDefault}), http.StatusBadRequest, "card_auto_finalize")
	withPay := map[string]any{"credit_limit": "20000", "statement_day": 1, "due_day": 15, "minimum_payment": "300",
		"default_account_id": main.Id, "pay": pay}
	w = do(http.MethodPatch, "/api/v1/accounts/"+visa.Id, map[string]any{"credit_card": withPay})
	expect(t, "set the defaults", w, http.StatusOK, "")
	if p := decode[api.Account](t, w).CreditCard.MustGet().Pay; !p.AutoFinalize || p.DaysBefore != 2 || p.Mode != api.ScheduleModeAuto {
		t.Fatalf("the defaults %+v", p)
	}
	// An edit without them keeps them.
	w = do(http.MethodPatch, "/api/v1/accounts/"+visa.Id, map[string]any{"credit_card": fields})
	expect(t, "edit the card", w, http.StatusOK, "")
	if p := decode[api.Account](t, w).CreditCard.MustGet().Pay; !p.AutoFinalize || p.DaysBefore != 2 {
		t.Fatalf("kept defaults %+v", p)
	}

	// March: auto-finalized on the payment day (2 days before the due
	// date), paid at once.
	now = time.Date(2027, 2, 11, 10, 0, 0, 0, time.UTC)
	purchase("300", "2027-02-10T12:00:00Z")
	now = time.Date(2027, 3, 12, 10, 0, 0, 0, time.UTC)
	if err := acc.RunBills(t.Context(), discard()); err != nil {
		t.Fatal(err)
	}
	if cur := bill().Current.MustGet(); cur.Fixed {
		t.Fatalf("finalized before the payment day %+v", cur)
	}
	now = time.Date(2027, 3, 13, 10, 0, 0, 0, time.UTC)
	if err := acc.RunBills(t.Context(), discard()); err != nil {
		t.Fatal(err)
	}
	if cur := bill().Current.MustGet(); !cur.Fixed || cur.FixedBy.MustGet() != api.CardStatementFixedByAuto || cur.Left != "0.00" {
		t.Fatalf("auto-finalized %+v", cur)
	}

	// April: asking first, auto-finalize queues the minimum.
	pay["mode"], pay["rule"] = "approve", "minimum"
	expect(t, "ask first", do(http.MethodPatch, "/api/v1/accounts/"+visa.Id, map[string]any{"credit_card": withPay}),
		http.StatusOK, "")
	now = time.Date(2027, 3, 21, 10, 0, 0, 0, time.UTC)
	purchase("400", "2027-03-20T12:00:00Z")
	now = time.Date(2027, 4, 13, 10, 0, 0, 0, time.UTC)
	if err := acc.RunBills(t.Context(), discard()); err != nil {
		t.Fatal(err)
	}
	b = bill()
	if p := b.Payment.MustGet(); b.Current.MustGet().FixedBy.MustGet() != api.CardStatementFixedByAuto ||
		p.State != api.CardBillPaymentStateQueued || p.Amount != "300.00" {
		t.Fatalf("auto-finalized, asking first %+v", b)
	}
	if q := queued(); len(q) != 1 {
		t.Errorf("queued %+v", q)
	}
}
