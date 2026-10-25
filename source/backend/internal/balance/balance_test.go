package balance_test

import (
	"errors"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

// October and November 2026 in Oslo.
var octStart, novStart, novEnd = at("2026-09-30T22:00:00Z"), at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")

type line struct {
	id, amount string
}

func TestBalancesAndCycleFigures(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	l := ledger.New(ledger.Options{})
	user := authtest.NewUser(t, pool, "alice").ID
	acc := ledgertest.Account(t, pool, user, "")
	empty := ledgertest.Account(t, pool, user, "")
	groceries := ledgertest.Bucket(t, pool, user, acc)
	hobby := ledgertest.Bucket(t, pool, user, acc)
	unused := ledgertest.Bucket(t, pool, user, acc)
	oct := ledgertest.Cycle(t, pool, user, octStart, novStart, "active")

	record := func(typ sqlc.TransactionType, when string, bank []line, buckets []line) *ledger.Transaction {
		t.Helper()
		e := ledger.Entry{UserID: user, Type: typ, At: at(when)}
		for _, b := range bank {
			e.BankLines = append(e.BankLines, ledger.BankLine{AccountID: b.id, Amount: dec(b.amount)})
		}
		for _, b := range buckets {
			e.BucketLines = append(e.BucketLines, ledger.BucketLine{BucketID: b.id, Amount: dec(b.amount)})
		}
		tx, err := l.Create(ctx, pool, e)
		if err != nil {
			t.Fatal(err)
		}
		return tx
	}

	// October.
	record(sqlc.TransactionTypeOPB, "2026-10-01T08:00:00Z", []line{{acc, "10000"}}, nil)
	record(sqlc.TransactionTypeOPF, "2026-10-01T08:00:00Z", nil, []line{{groceries, "500"}})
	record(sqlc.TransactionTypeREF, "2026-10-01T08:00:00Z", nil, []line{{groceries, "1500"}})
	record(sqlc.TransactionTypeINC, "2026-10-10T08:00:00Z", []line{{acc, "5000"}}, []line{{groceries, "1000"}})
	exp := record(sqlc.TransactionTypeEXP, "2026-10-12T16:00:00Z", []line{{acc, "-300"}}, []line{{groceries, "-300"}})
	// 300 corrected to 350.
	if _, err := l.Create(ctx, pool, ledger.Entry{
		UserID: user, Type: sqlc.TransactionTypeEXP, At: at("2026-10-12T16:00:00Z"),
		Correction: sqlc.CorrectionTypeAdjustment, ParentID: exp.Header.ID,
		BankLines:   []ledger.BankLine{{AccountID: acc, Amount: dec("-50")}},
		BucketLines: []ledger.BucketLine{{BucketID: groceries, Amount: dec("-50")}},
	}); err != nil {
		t.Fatal(err)
	}
	record(sqlc.TransactionTypeBAT, "2026-10-20T08:00:00Z", nil, []line{{groceries, "-200"}, {hobby, "200"}})
	record(sqlc.TransactionTypeOVF, "2026-10-31T22:00:00Z", nil, []line{{groceries, "-100"}})

	// November.
	if _, err := pool.Exec(ctx, "UPDATE cycles SET state = 'finished' WHERE id = $1", oct); err != nil {
		t.Fatal(err)
	}
	nov := ledgertest.Cycle(t, pool, user, novStart, novEnd, "active")
	record(sqlc.TransactionTypeREF, "2026-11-01T08:00:00Z", nil, []line{{groceries, "1000"}})
	record(sqlc.TransactionTypeEXP, "2026-11-02T12:00:00Z", []line{{acc, "-400"}}, []line{{groceries, "-400"}})
	record(sqlc.TransactionTypeOVF, "2026-11-02T12:00:00Z", nil, []line{{groceries, "-50"}})

	// Another user's money never counts.
	bob := authtest.NewUser(t, pool, "bob").ID
	bobAcc := ledgertest.Account(t, pool, bob, "")
	bobCycle := ledgertest.Cycle(t, pool, bob, octStart, novStart, "active")
	bobOPB := ledger.Entry{UserID: bob, Type: sqlc.TransactionTypeOPB, At: at("2026-10-01T08:00:00Z"),
		BankLines: []ledger.BankLine{{AccountID: bobAcc, Amount: dec("999")}}}
	if _, err := l.Create(ctx, pool, bobOPB); err != nil {
		t.Fatal(err)
	}

	same := func(what string, got, want decimal.Decimal) {
		t.Helper()
		if !got.Equal(want) {
			t.Errorf("%s = %s, want %s", what, got, want)
		}
	}

	balances, err := balance.Accounts(ctx, pool, user)
	if err != nil {
		t.Fatal(err)
	}
	if len(balances) != 2 {
		t.Errorf("got %d accounts, want 2", len(balances))
	}
	same("balance", balances[acc], dec("14250"))
	same("empty account", balances[empty], decimal.Zero)

	before, err := balance.AccountsBefore(ctx, pool, user, novStart)
	if err != nil {
		t.Fatal(err)
	}
	same("balance before November", before[acc], dec("14650"))
	before, err = balance.AccountsBefore(ctx, pool, user, at("2026-10-12T16:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	same("balance before the expense", before[acc], dec("15000"))

	tf, err := balance.Buckets(ctx, pool, user)
	if err != nil {
		t.Fatal(err)
	}
	if len(tf) != 3 {
		t.Errorf("got %d buckets, want 3", len(tf))
	}
	same("groceries TF", tf[groceries], dec("2900"))
	same("hobby TF", tf[hobby], dec("200"))
	same("unused TF", tf[unused], decimal.Zero)

	check := func(name string, got balance.Figures, start, budget, used, overflow, left string) {
		t.Helper()
		same(name+" start", got.Start, dec(start))
		same(name+" budget", got.Budget, dec(budget))
		same(name+" used", got.Used, dec(used))
		same(name+" overflow", got.Overflow, dec(overflow))
		same(name+" left", got.Left, dec(left))
	}

	// October is unaffected by November's lines.
	figs, err := balance.Cycle(ctx, pool, user, oct)
	if err != nil {
		t.Fatal(err)
	}
	check("October groceries", figs[groceries], "0", "2800", "350", "100", "2350")
	check("October hobby", figs[hobby], "0", "200", "0", "0", "200")
	check("October unused", figs[unused], "0", "0", "0", "0", "0")

	figs, err = balance.Cycle(ctx, pool, user, nov)
	if err != nil {
		t.Fatal(err)
	}
	check("November groceries", figs[groceries], "2350", "3350", "400", "50", "2900")
	check("November hobby", figs[hobby], "200", "200", "0", "0", "200")
	if !figs[groceries].Left.Equal(tf[groceries]) {
		t.Errorf("active cycle's Left %s isn't the current TF %s", figs[groceries].Left, tf[groceries])
	}

	if _, err := balance.Cycle(ctx, pool, user, bobCycle); !errors.Is(err, balance.ErrNotFound) {
		t.Errorf("another user's cycle: %v", err)
	}
}
