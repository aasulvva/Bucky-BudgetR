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

// TestCardInterest: a card's interest and fees (#263) — the reminder after
// a bill that wasn't paid in full by its due date, gone once interest or a
// fee is registered, dismissed or switched off, and back the next carried
// cycle; and Finalize registering a higher bank amount's difference as
// interest instead of a balance adjustment.
func TestCardInterest(t *testing.T) {
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
	visa := create(map[string]any{"name": "Visa", "type": "credit_card", "bank": "DNB",
		"credit_card": map[string]any{"credit_limit": "20000", "statement_day": 1, "due_day": 15,
			"minimum_payment": "300", "default_account_id": main.Id},
		"opening_balance": "-4520", "opening_at": "2026-10-20T12:00:00Z"})
	pay := func(amount string) {
		t.Helper()
		expect(t, "pay "+amount, do(http.MethodPost, "/api/v1/transactions", map[string]any{
			"type": "TRF", "account_id": main.Id, "to_account_id": visa.Id, "amount": amount,
		}), http.StatusCreated, "")
	}
	finalize := func(what string, body map[string]any, status int) api.CardBillFinalized {
		t.Helper()
		w := do(http.MethodPost, "/api/v1/accounts/"+visa.Id+"/bill/finalize", body)
		expect(t, what, w, status, "")
		if status != http.StatusOK {
			return api.CardBillFinalized{}
		}
		return decode[api.CardBillFinalized](t, w)
	}
	reminders := func() []api.Notification {
		t.Helper()
		var out []api.Notification
		for _, n := range decode[api.NotificationList](t, do(http.MethodGet, "/api/v1/notifications", nil)).Items {
			if n.Kind == api.NotificationKindCardInterest {
				out = append(out, n)
			}
		}
		return out
	}
	oneReminder := func(what, left, due string) api.Notification {
		t.Helper()
		got := reminders()
		if len(got) != 1 || got[0].Severity != api.NotificationSeverityInfo || got[0].Amount.MustGet() != left ||
			got[0].AccountId.MustGet() != visa.Id || got[0].At.MustGet().Format(time.RFC3339) != due {
			t.Fatalf("%s: reminders %+v", what, got)
		}
		return got[0]
	}
	noReminder := func(what string) {
		t.Helper()
		if got := reminders(); len(got) != 0 {
			t.Fatalf("%s: reminders %+v", what, got)
		}
	}
	// Transactions on the card of a type, with their time, counterparty and tags.
	type line struct {
		at           time.Time
		amount       string
		counterparty string
		tags         string
	}
	onCard := func(kind string) []line {
		t.Helper()
		rows, err := pool.Query(t.Context(), `SELECT h.transaction_at, l.amount::text, h.counterparty,
			COALESCE((SELECT string_agg(g.name, ',') FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
			          WHERE tt.transaction_id = h.id), '')
			FROM transaction_headers h JOIN bank_transactions l ON l.transaction_id = h.id
			WHERE l.account_id = $1 AND h.transaction_type = $2 ORDER BY h.transaction_at`, visa.Id, kind)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []line
		for rows.Next() {
			var x line
			if err := rows.Scan(&x.at, &x.amount, &x.counterparty, &x.tags); err != nil {
				t.Fatal(err)
			}
			out = append(out, x)
		}
		return out
	}

	// December's bill (4 520) is only partly paid by its due date.
	now = time.Date(2026, 12, 2, 10, 0, 0, 0, time.UTC)
	finalize("December", map[string]any{"amount": "4520", "payment": nil}, http.StatusOK)
	now = time.Date(2026, 12, 10, 10, 0, 0, 0, time.UTC)
	pay("1000")
	now = time.Date(2026, 12, 20, 10, 0, 0, 0, time.UTC)
	noReminder("before the next statement")

	// January's statement brings the reminder for what carried over.
	now = time.Date(2027, 1, 2, 10, 0, 0, 0, time.UTC)
	oneReminder("January", "3520.00", "2026-12-14T23:00:00Z")
	// Finalizing with the bank's higher amount registers the difference as
	// interest, which answers the reminder.
	finalize("a bad tag", map[string]any{"amount": "3570", "payment": nil,
		"difference": map[string]any{"tag": "bonus", "counterparty": "DNB"}}, http.StatusBadRequest)
	done := finalize("with interest", map[string]any{"amount": "3570", "payment": nil,
		"difference": map[string]any{"tag": "interest", "counterparty": "DNB"}}, http.StatusOK)
	if cur := done.Bill.Current.MustGet(); cur.Amount != "3570.00" || !cur.Fixed {
		t.Fatalf("January with interest %+v", cur)
	}
	cutoff := time.Date(2026, 12, 31, 23, 0, 0, 0, time.UTC).Add(-time.Microsecond)
	if got := onCard("EXP"); len(got) != 1 || !got[0].at.Equal(cutoff) || got[0].amount != "-50.00" ||
		got[0].counterparty != "DNB" || got[0].tags != "interest" {
		t.Fatalf("the interest %+v", got)
	}
	if got := onCard("BLA"); len(got) != 0 {
		t.Fatalf("an adjustment too %+v", got)
	}
	// It's set aside on the default account, as a purchase is.
	w := do(http.MethodGet, "/api/v1/accounts/"+visa.Id, nil)
	if held := decode[api.Account](t, w).CreditCard.MustGet().HeldOn; len(held) != 1 || held[0].AccountId != main.Id {
		t.Fatalf("held on %+v", held)
	}
	noReminder("interest registered")

	// January isn't paid at all: February's reminder, gone with a fee.
	now = time.Date(2027, 2, 2, 10, 0, 0, 0, time.UTC)
	oneReminder("February", "3570.00", "2027-01-14T23:00:00Z")
	expect(t, "a fee", do(http.MethodPost, "/api/v1/transactions", map[string]any{
		"type": "EXP", "account_id": visa.Id, "amount": "35", "counterparty": "DNB", "tags": []string{"fee"},
	}), http.StatusCreated, "")
	noReminder("a fee registered")
	// A lower bank amount is a balance adjustment, even with a difference.
	finalize("lower", map[string]any{"amount": "3500", "payment": nil,
		"difference": map[string]any{"tag": "interest", "counterparty": "DNB"}}, http.StatusOK)
	if got := onCard("BLA"); len(got) != 1 {
		t.Fatalf("the adjustment %+v", got)
	}

	// March: still unpaid, the reminder is back; switched off, then dismissed.
	now = time.Date(2027, 3, 2, 10, 0, 0, 0, time.UTC)
	n := oneReminder("March", "3500.00", "2027-02-14T23:00:00Z")
	expect(t, "switched off", do(http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"notifications": map[string]any{"card_bills": false}}), http.StatusOK, "")
	noReminder("switched off")
	expect(t, "switched on", do(http.MethodPatch, "/api/v1/me/preferences",
		map[string]any{"notifications": map[string]any{"card_bills": true}}), http.StatusOK, "")
	expect(t, "dismiss", do(http.MethodPost, "/api/v1/notifications/dismiss", map[string]any{"key": n.Key}),
		http.StatusNoContent, "")
	noReminder("dismissed")

	// Paid in full by its due date, there's none the next month.
	now = time.Date(2027, 3, 10, 10, 0, 0, 0, time.UTC)
	pay("5000")
	now = time.Date(2027, 4, 2, 10, 0, 0, 0, time.UTC)
	noReminder("paid in full")
}
