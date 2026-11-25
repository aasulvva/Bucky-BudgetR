package httpapi_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
)

// TestPlannedPurchases: a game pre-ordered on the card (#265) is set aside in
// the Games bucket in the cycle of its expected date, follows its date when
// it's moved, moves to the active cycle once its own is over, and closes
// when its charge is recorded.
func TestPlannedPurchases(t *testing.T) {
	w := newWaitingWorld(t, time.Date(2027, 1, 5, 10, 0, 0, 0, time.UTC))
	jan := w.cycle(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC))
	feb := w.cycle(time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC))
	w.ok("start January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/start", nil, http.StatusOK)
	main := decode[api.Account](t, w.ok("Main", http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Main", "opening_balance": "10000", "opening_at": "2027-01-02T12:00:00Z"}, http.StatusCreated))
	other := decode[api.Account](t, w.ok("Other", http.MethodPost, "/api/v1/accounts",
		map[string]any{"name": "Other", "opening_balance": "1000", "opening_at": "2027-01-02T12:00:00Z"}, http.StatusCreated))
	visa := decode[api.Account](t, w.ok("Visa", http.MethodPost, "/api/v1/accounts", map[string]any{
		"name": "Visa", "type": "credit_card", "credit_card": map[string]any{"credit_limit": "5000", "statement_day": 1,
			"due_day": 15, "minimum_payment": "300", "default_account_id": main.Id},
	}, http.StatusCreated))
	games := decode[api.Bucket](t, w.ok("Games", http.MethodPost, "/api/v1/buckets", map[string]any{
		"name": "Games", "source_account_id": main.Id, "refill_amount": "1000", "refill_mode": "manual",
	}, http.StatusCreated))
	w.ok("refill Games", http.MethodPost, "/api/v1/buckets/"+games.Id+"/refill", nil, http.StatusOK)

	get := func(id string) api.PlannedPurchase {
		t.Helper()
		return decode[api.PlannedPurchase](t, w.ok("get plan", http.MethodGet, "/api/v1/planned-purchases/"+id, nil, http.StatusOK))
	}
	list := func(status string) []api.PlannedPurchase {
		t.Helper()
		return decode[[]api.PlannedPurchase](t, w.ok("list", http.MethodGet, "/api/v1/planned-purchases?status="+status, nil, http.StatusOK))
	}
	aside := func(cycleID string) string {
		t.Helper()
		for _, f := range decode[[]api.BucketFigures](t, w.ok("figures", http.MethodGet,
			"/api/v1/cycles/"+cycleID+"/bucket-figures", nil, http.StatusOK)) {
			if f.BucketId == games.Id {
				return f.Planned
			}
		}
		t.Fatalf("no figures for Games")
		return ""
	}
	notes := func() []api.Notification {
		t.Helper()
		var out []api.Notification
		for _, n := range decode[api.NotificationList](t, w.ok("notifications", http.MethodGet, "/api/v1/notifications", nil, http.StatusOK)).Items {
			if n.Kind == api.NotificationKindPlannedPurchase {
				out = append(out, n)
			}
		}
		return out
	}
	cycleOf := func(p api.PlannedPurchase) string {
		id, _ := p.CycleId.Get()
		return id
	}

	// It's checked as the expense it plans.
	for _, c := range []struct {
		what string
		body map[string]any
	}{
		{"no name", map[string]any{"name": " ", "account_id": visa.Id, "amount": "600", "expected_at": "2027-02-10T00:00:00Z"}},
		{"buckets over the amount", map[string]any{"name": "Shop", "account_id": visa.Id, "amount": "600", "expected_at": "2027-02-10T00:00:00Z",
			"bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "700"}}}},
		{"a debit account's bucket on another account", map[string]any{"name": "Shop", "account_id": other.Id, "amount": "600",
			"expected_at": "2027-02-10T00:00:00Z", "bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "600"}}}},
	} {
		expect(t, c.what, w.do(http.MethodPost, "/api/v1/planned-purchases", c.body), http.StatusBadRequest, "invalid_request")
	}

	// A card's buckets may be on any account in its currency (#261).
	game := decode[api.PlannedPurchase](t, w.ok("pre-order", http.MethodPost, "/api/v1/planned-purchases", map[string]any{
		"name": " Game Store ", "account_id": visa.Id, "amount": "600", "expected_at": "2027-02-10T00:00:00Z", "note": "Collector's edition",
		"bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "500"}},
	}, http.StatusCreated))
	if len(game.Id) != 16 || !strings.HasPrefix(game.Id, jan.Id[:6]) || game.Name != "Game Store" || game.Currency != "NOK" ||
		game.Status != api.PlannedPurchaseStatusOpen || cycleOf(game) != feb.Id || game.Overdue ||
		len(game.BucketLines) != 1 || game.BucketLines[0].Amount != "500.00" {
		t.Fatalf("the pre-order %+v", game)
	}
	if got := aside(jan.Id); got != "0.00" {
		t.Errorf("January sets aside %s", got)
	}
	if got := aside(feb.Id); got != "500.00" {
		t.Errorf("February sets aside %s", got)
	}
	if n := notes(); len(n) != 0 {
		t.Errorf("notified early: %+v", n)
	}

	// Released sooner: it moves to January, and is due within 3 days.
	game = decode[api.PlannedPurchase](t, w.ok("move date", http.MethodPatch, "/api/v1/planned-purchases/"+game.Id,
		map[string]any{"expected_at": "2027-01-06T00:00:00Z"}, http.StatusOK))
	if cycleOf(game) != jan.Id || game.Note != "Collector's edition" || len(game.BucketLines) != 1 {
		t.Fatalf("moved %+v", game)
	}
	if got := aside(jan.Id); got != "500.00" {
		t.Errorf("January sets aside %s after the move", got)
	}
	n := notes()
	if len(n) != 1 || n[0].Severity != api.NotificationSeverityInfo || n[0].Key != "planned:"+game.Id+":"+strconv.FormatInt(time.Date(2027, 1, 6, 0, 0, 0, 0, time.UTC).Unix(), 10) {
		t.Fatalf("upcoming %+v", n)
	}
	if id, _ := n[0].PlannedId.Get(); id != game.Id {
		t.Errorf("planned_id %v", n[0].PlannedId)
	}
	if name, _ := n[0].Counterparty.Get(); name != "Game Store" {
		t.Errorf("counterparty %v", n[0].Counterparty)
	}

	// Its day goes by without the charge: overdue, a warning keyed apart.
	*w.now = time.Date(2027, 1, 7, 10, 0, 0, 0, time.UTC)
	if !get(game.Id).Overdue {
		t.Errorf("not overdue")
	}
	if n := notes(); len(n) != 1 || n[0].Severity != api.NotificationSeverityWarning || !strings.HasSuffix(n[0].Key, ":overdue") {
		t.Fatalf("overdue %+v", n)
	}

	// January ends: Games is emptied as usual, and the plan counts in
	// February, the active cycle.
	*w.now = time.Date(2027, 2, 1, 10, 0, 0, 0, time.UTC)
	w.ok("end January", http.MethodPost, "/api/v1/cycles/"+jan.Id+"/end", map[string]any{}, http.StatusOK)
	if b := w.bucket(games.Id); b.TargetFunds != "0.00" {
		t.Errorf("Games after January %s", b.TargetFunds)
	}
	if got := cycleOf(get(game.Id)); got != feb.Id {
		t.Errorf("counts in %s, want February", got)
	}
	if got, want := aside(jan.Id)+" "+aside(feb.Id), "0.00 500.00"; got != want {
		t.Errorf("set aside %s, want %s", got, want)
	}
	w.ok("refill Games", http.MethodPost, "/api/v1/buckets/"+games.Id+"/refill", nil, http.StatusOK)

	// Only an expense on its account records its charge.
	expect(t, "an income", w.do(http.MethodPost, "/api/v1/transactions", map[string]any{
		"type": "INC", "account_id": visa.Id, "amount": "650", "planned_purchase_id": game.Id,
	}), http.StatusBadRequest, "invalid_request")
	w.purchase("on another account", map[string]any{"account_id": main.Id, "amount": "650", "planned_purchase_id": game.Id},
		http.StatusBadRequest, "invalid_request")
	charge := w.purchase("the charge", map[string]any{"account_id": visa.Id, "amount": "650", "counterparty": "Game Store",
		"bucket_lines": []map[string]any{{"bucket_id": games.Id, "amount": "650"}}, "planned_purchase_id": game.Id},
		http.StatusCreated, "")
	game = get(game.Id)
	if id, _ := game.TransactionId.Get(); game.Status != api.PlannedPurchaseStatusCharged || id != charge.Id || game.CycleId.IsSpecified() && !game.CycleId.IsNull() {
		t.Fatalf("charged %+v", game)
	}
	if got := aside(feb.Id); got != "0.00" {
		t.Errorf("February sets aside %s once charged", got)
	}
	if len(list("open")) != 0 || len(list("closed")) != 1 || len(notes()) != 0 {
		t.Errorf("open %+v, closed %+v", list("open"), list("closed"))
	}
	w.purchase("charged again", map[string]any{"account_id": visa.Id, "amount": "650", "planned_purchase_id": game.Id},
		http.StatusConflict, "planned_closed")
	expect(t, "edit a charged one", w.do(http.MethodPatch, "/api/v1/planned-purchases/"+game.Id, map[string]any{"amount": "1"}),
		http.StatusConflict, "planned_closed")

	// Cancelling keeps it, closed.
	gift := decode[api.PlannedPurchase](t, w.ok("gift", http.MethodPost, "/api/v1/planned-purchases", map[string]any{
		"name": "Gift", "account_id": main.Id, "amount": "200", "expected_at": "2027-02-20T00:00:00Z",
	}, http.StatusCreated))
	w.ok("cancel", http.MethodDelete, "/api/v1/planned-purchases/"+gift.Id, nil, http.StatusNoContent)
	if got := get(gift.Id); got.Status != api.PlannedPurchaseStatusCancelled {
		t.Errorf("cancelled %+v", got)
	}
	expect(t, "cancel twice", w.do(http.MethodDelete, "/api/v1/planned-purchases/"+gift.Id, nil), http.StatusConflict, "planned_closed")
	if got := list("closed"); len(got) != 2 {
		t.Errorf("closed %+v", got)
	}
	expect(t, "someone else's", w.do(http.MethodGet, "/api/v1/planned-purchases/1000001234567890", nil), http.StatusNotFound, "not_found")
}
