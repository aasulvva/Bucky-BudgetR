package cards_test

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func TestCheckFields(t *testing.T) {
	ok := cards.Fields{BillAccountID: "1234", CreditLimit: dec("20000"), StatementDay: 1, DueDay: 15, MinimumPayment: dec("300")}
	if err := cards.CheckFields(ok); err != nil {
		t.Errorf("valid fields: %v", err)
	}
	for name, change := range map[string]func(f *cards.Fields){
		"no limit":         func(f *cards.Fields) { f.CreditLimit = decimal.Zero },
		"3 decimals":       func(f *cards.Fields) { f.CreditLimit = dec("1.001") },
		"no minimum":       func(f *cards.Fields) { f.MinimumPayment = dec("-1") },
		"statement day 0":  func(f *cards.Fields) { f.StatementDay = 0 },
		"statement day 29": func(f *cards.Fields) { f.StatementDay = 29 },
		"due day 30":       func(f *cards.Fields) { f.DueDay = 30 },
		"due day 32":       func(f *cards.Fields) { f.DueDay = 32 },
	} {
		f := ok
		change(&f)
		if err := cards.CheckFields(f); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	f := ok
	f.StatementDay, f.DueDay = cards.LastDay, 28
	if err := cards.CheckFields(f); err != nil {
		t.Errorf("the last day: %v", err)
	}
}

func TestStatusOf(t *testing.T) {
	card := sqlc.BankAccount{
		AccountType: sqlc.AccountTypeCreditCard, CardBillAccountID: pgtype.Text{String: "1234", Valid: true},
		CardCreditLimit:  decimal.NullDecimal{Decimal: dec("20000"), Valid: true},
		CardStatementDay: pgtype.Int2{Int16: 1, Valid: true}, CardDueDay: pgtype.Int2{Int16: 15, Valid: true},
		CardMinimumPayment: decimal.NullDecimal{Decimal: dec("300"), Valid: true},
	}
	for _, c := range []struct{ balance, owed, available, used string }{
		{"-18000", "18000", "2000", "90"},
		{"-21000", "21000", "-1000", "105"},
		{"500", "0", "20500", "0"}, // in credit
	} {
		st, ok := cards.StatusOf(card, dec(c.balance))
		if !ok || !st.Owed.Equal(dec(c.owed)) || !st.Available.Equal(dec(c.available)) || !st.UsedPercent().Equal(dec(c.used)) || st.Locked {
			t.Errorf("balance %s: %+v, used %s", c.balance, st, st.UsedPercent())
		}
	}
	card.CardBillAccountID = pgtype.Text{}
	if st, _ := cards.StatusOf(card, decimal.Zero); !st.Locked {
		t.Error("no bill account, not locked")
	}
	if _, ok := cards.StatusOf(sqlc.BankAccount{AccountType: sqlc.AccountTypeUsage}, decimal.Zero); ok {
		t.Error("a usage account has a card status")
	}
}
