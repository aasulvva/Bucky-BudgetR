package userdata_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// A credit card's bill account follows it into the copy (#260).
func TestCreditCardFollows(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	carol := authtest.NewUser(t, e.pool, "carol")
	main := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{Name: "Main"}))
	must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{
		Name: "Visa", Type: sqlc.AccountTypeCreditCard, OpeningBalance: dec("-1500"),
		Card: &cards.Fields{DefaultAccountID: main.ID, CreditLimit: dec("20000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")},
	}))
	f, _ := e.file(t, carol.ID)

	dave := authtest.NewUser(t, e.pool, "dave")
	must[userdata.Counts](t)(e.svc.Import(ctx, dave.ID, f))
	list := must[[]accounts.Account](t)(e.accounts.List(ctx, dave.ID))
	ids := map[string]string{}
	var card accounts.Account
	for _, a := range list {
		ids[a.Name] = a.ID
		if a.Name == "Visa" {
			card = a
		}
	}
	if card.Card == nil {
		t.Fatalf("the copy isn't a card: %+v", card)
	}
	got := fmt.Sprintf("%s %s %d %d %s %s", card.Card.DefaultAccountID, card.Card.CreditLimit, card.Card.StatementDay,
		card.Card.DueDay, card.Card.MinimumPayment, card.Card.Owed)
	if want := fmt.Sprintf("%s 20000 1 15 300 1500", ids["Main"]); got != want || ids["Main"] == main.ID {
		t.Errorf("the copied card %q, want %q", got, want)
	}
}

// Card debt held on an account (#261) follows the card and the account into
// the copy, its lines taking the copied card's ID as prefix.
func TestCardDebtFollows(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	carol := authtest.NewUser(t, e.pool, "carol")
	main := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{Name: "Main", OpeningBalance: dec("1000")}))
	visa := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{
		Name: "Visa", Type: sqlc.AccountTypeCreditCard,
		Card: &cards.Fields{DefaultAccountID: main.ID, CreditLimit: dec("20000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")},
	}))
	must[transactions.Transaction](t)(e.tx.Create(ctx, carol.ID, transactions.New{
		Type: sqlc.TransactionTypeEXP, AccountID: visa.ID, Amount: dec("250"), At: clock(),
	}))
	f, _ := e.file(t, carol.ID)
	if n := len(f.Data.Tables["card_debt_lines"]); n != 1 {
		t.Fatalf("exported %d card debt lines, want 1", n)
	}

	dave := authtest.NewUser(t, e.pool, "dave")
	must[userdata.Counts](t)(e.svc.Import(ctx, dave.ID, f))
	ids := map[string]accounts.Account{}
	for _, a := range must[[]accounts.Account](t)(e.accounts.List(ctx, dave.ID)) {
		ids[a.Name] = a
	}
	card, held := ids["Visa"], ids["Main"]
	if card.ID == visa.ID || held.CardHolds[card.ID].StringFixed(2) != "250.00" || card.Card.SetAside.StringFixed(2) != "250.00" {
		t.Errorf("the copy: Main holds %v, Visa %+v", held.CardHolds, card.Card)
	}
	for _, line := range must[userdata.File](t)(e.svc.Export(ctx, dave.ID)).Data.Tables["card_debt_lines"] {
		if !strings.HasPrefix(line["id"].(string), card.ID) || line["card_id"] != card.ID || line["account_id"] != held.ID {
			t.Errorf("dave's card debt line %v", line)
		}
	}
}

// A card's stored statements (#262) and its bill's setup follow it into the
// copy, their IDs taking the copied card's ID.
func TestCardStatementsFollow(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	carol := authtest.NewUser(t, e.pool, "carol")
	main := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{Name: "Main", OpeningBalance: dec("5000")}))
	visa := must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{
		Name: "Visa", Type: sqlc.AccountTypeCreditCard, OpeningBalance: dec("-1500"),
		Card:          &cards.Fields{CreditLimit: dec("20000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")},
		LastStatement: &cards.LastStatement{Amount: dec("1200"), Paid: dec("200")},
	}))
	sch := schedules.NewService(e.pool, schedules.Options{Now: clock, Transactions: e.tx})
	if err := pgx.BeginFunc(ctx, e.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, carol.ID); err != nil {
			return err
		}
		_, err := sch.CreateBillPayment(ctx, tx, carol.ID, schedules.Settings{
			Transaction: transactions.New{Type: sqlc.TransactionTypeTRF, AccountID: main.ID, ToAccountID: visa.ID, Amount: dec("1000")},
			Mode:        sqlc.ScheduleModeAuto, Start: clock().AddDate(0, 0, 3), Minute: 8 * 60, TimeZone: "UTC",
			Frequency: sqlc.ScheduleFrequencyOnce,
			Bill:      &schedules.Bill{StatementID: visa.Card.Bill.Current.ID, Rule: cards.PayFull, Amount: dec("1000")},
		})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	f, _ := e.file(t, carol.ID)
	if n := len(f.Data.Tables["card_statements"]); n != 1 {
		t.Fatalf("exported %d card statements, want 1", n)
	}

	dave := authtest.NewUser(t, e.pool, "dave")
	must[userdata.Counts](t)(e.svc.Import(ctx, dave.ID, f))
	var card accounts.Account
	for _, a := range must[[]accounts.Account](t)(e.accounts.List(ctx, dave.ID)) {
		if a.Name == "Visa" {
			card = a
		}
	}
	bill := card.Card.Bill
	if card.ID == visa.ID || bill == nil || !bill.SetUp || bill.Current == nil || !bill.Current.Fixed ||
		bill.Current.ID != card.ID+visa.Card.Bill.Current.ID[4:] || bill.Current.Left.StringFixed(2) != "1000.00" {
		t.Errorf("the copy's bill %+v (card %s)", bill, card.ID)
	}
	// The statement's payment follows it, paying what's left.
	if p := bill.Payment; p == nil || p.AccountID == main.ID || p.Amount.StringFixed(2) != "1000.00" || p.Rule != cards.PayFull {
		t.Errorf("the copy's payment %+v", p)
	}
}

// A format 2 file's credit cards get the app's defaults for paying the bill
// (#262).
func TestCardPayDefaultsUpgrade(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	carol := authtest.NewUser(t, e.pool, "carol")
	must[accounts.Account](t)(e.accounts.Create(ctx, carol.ID, accounts.New{
		Name: "Visa", Type: sqlc.AccountTypeCreditCard,
		Card: &cards.Fields{CreditLimit: dec("20000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")},
	}))
	f, _ := e.file(t, carol.ID)
	f.Format = 2
	for _, r := range f.Data.Tables["bank_accounts"] {
		for _, c := range []string{"card_pay_rule", "card_pay_amount", "card_pay_days_before", "card_pay_mode", "card_auto_finalize"} {
			delete(r, c)
		}
	}
	raw, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	read := must[userdata.File](t)(userdata.ParseFile(raw))
	dave := authtest.NewUser(t, e.pool, "dave")
	must[userdata.Counts](t)(e.svc.Import(ctx, dave.ID, read))
	for _, a := range must[[]accounts.Account](t)(e.accounts.List(ctx, dave.ID)) {
		if p := a.Card.Pay; p == nil || p.Rule != cards.PayFull || p.Mode != sqlc.ScheduleModeApprove || p.AutoFinalize {
			t.Errorf("the copy's pay defaults %+v", p)
		}
	}
}
