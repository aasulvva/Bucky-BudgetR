package refill_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

// Months in Oslo, as the UI would send them.
var (
	oct = [2]time.Time{at("2026-09-30T22:00:00Z"), at("2026-10-31T23:00:00Z")}
	nov = [2]time.Time{at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")}
)

type env struct {
	pool     *pgxpool.Pool
	now      *time.Time
	user     string
	refills  *refill.Service
	cycles   *cycles.Service
	accounts *accounts.Service
	buckets  *buckets.Service
	tx       *transactions.Service
	oct, nov sqlc.Cycle
}

// setup gives alice an active October cycle and a planned November one, on
// 10 October.
func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	now := at("2026-10-10T12:00:00Z")
	clock := func() time.Time { return now }
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	r := refill.NewService(pool, l, refill.Options{Now: clock})
	e := env{
		pool: pool, now: &now, user: authtest.NewUser(t, pool, "alice").ID, refills: r,
		cycles:   cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart}),
		accounts: accounts.NewService(pool, l, accounts.Options{Now: clock}),
		buckets:  buckets.NewService(pool, l, buckets.Options{Now: clock}),
		tx:       transactions.NewService(pool, l, transactions.Options{Now: clock, Refills: r}),
	}
	var err error
	if e.oct, err = e.cycles.Create(t.Context(), e.user, oct[0], oct[1]); err != nil {
		t.Fatal(err)
	}
	if e.nov, err = e.cycles.Create(t.Context(), e.user, nov[0], nov[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := e.cycles.Start(t.Context(), e.user, e.oct.ID); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e env) account(t *testing.T, balance string) string {
	t.Helper()
	a, err := e.accounts.Create(t.Context(), e.user, accounts.New{Name: "Account " + balance + fmt.Sprint(time.Now().UnixNano()), OpeningBalance: dec(balance)})
	if err != nil {
		t.Fatal(err)
	}
	return a.ID
}

// bucket creates a bucket with RA 100 and, with keep funds, BC 150.
func (e env) bucket(t *testing.T, account string, keep bool, mode sqlc.RefillMode, opening string) string {
	t.Helper()
	b, err := e.buckets.Create(t.Context(), e.user, buckets.New{
		Name: fmt.Sprintf("B%d", time.Now().UnixNano()), SourceAccountID: account, RefillAmount: dec("100"),
		CapMultiplier: dec("1.5"), KeepFunds: keep, RefillMode: mode, OpeningFunds: dec(opening),
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.ID
}

func (e env) get(t *testing.T, id string) buckets.Bucket {
	t.Helper()
	b, err := e.buckets.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// lines returns the effective amounts of the bucket's transactions of a
// type, oldest first; reversed ones are left out.
func (e env) lines(t *testing.T, bucketID string, typ sqlc.TransactionType) []string {
	t.Helper()
	p, err := e.tx.List(t.Context(), e.user, transactions.Filter{BucketID: bucketID, Types: []sqlc.TransactionType{typ}})
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for i := len(p.Items) - 1; i >= 0; i-- {
		for _, l := range p.Items[i].BucketLines {
			out = append(out, l.Amount.StringFixed(2))
		}
	}
	return out
}

func (e env) income(t *testing.T, account, counterparty, amount string, triggers *bool) (transactions.Transaction, error) {
	t.Helper()
	return e.tx.Create(t.Context(), e.user, transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: account, Counterparty: counterparty, Amount: dec(amount), TriggersRefill: triggers,
	})
}

func ptr[T any](v T) *T { return &v }

func check(t *testing.T, what string, got, want any) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

// TestRefill covers keep funds × the refill modes the user triggers × a
// bucket below RA, one that would go above BC, and one in debt. RA is 100 and
// BC 150.
func TestRefill(t *testing.T) {
	e := setup(t)
	for _, keep := range []bool{false, true} {
		for _, mode := range []sqlc.RefillMode{sqlc.RefillModeManual, sqlc.RefillModeOnIncome} {
			for _, tc := range []struct {
				opening, expense string // expense from the bucket, to get a negative TF
				ref, ovf, tf     string // "" for no transaction
			}{
				{opening: "0", ref: "100.00", tf: "100.00"},
				{opening: "30", ref: "70.00", tf: "100.00"},
				{opening: "100", tf: "100.00"},
				{opening: "130", ref: "-30.00", tf: "100.00"},
				{opening: "30", expense: "50", ref: "120.00", tf: "100.00"},
			} {
				ref, ovf, tf := tc.ref, tc.ovf, tc.tf
				if keep {
					// REF = RA; what goes above BC overflows.
					start := dec(tc.opening)
					if tc.expense != "" {
						start = start.Sub(dec(tc.expense))
					}
					ref = "100.00"
					after := start.Add(dec("100"))
					if excess := after.Sub(dec("150")); excess.IsPositive() {
						ovf = excess.Neg().StringFixed(2)
						after = dec("150")
					}
					tf = after.StringFixed(2)
				}
				name := fmt.Sprintf("keep %v, %s, TF %s-%s", keep, mode, tc.opening, tc.expense)
				account := e.account(t, "1000")
				b := e.bucket(t, account, keep, mode, tc.opening)
				if tc.expense != "" {
					if _, err := e.tx.Create(t.Context(), e.user, transactions.New{
						Type: sqlc.TransactionTypeEXP, AccountID: account, Amount: dec(tc.expense),
						Buckets: []transactions.BucketAmount{{BucketID: b, Amount: dec(tc.expense)}},
					}); err != nil {
						t.Fatal(err)
					}
				}

				var again error
				if mode == sqlc.RefillModeManual {
					if err := e.refills.Manual(t.Context(), e.user, b); err != nil {
						t.Fatalf("%s: %v", name, err)
					}
					again = e.refills.Manual(t.Context(), e.user, b)
				} else {
					if _, err := e.income(t, account, "", "500", ptr(true)); err != nil {
						t.Fatalf("%s: %v", name, err)
					}
					_, again = e.income(t, account, "", "500", ptr(true))
				}

				var wantREF, wantOVF []string
				if ref != "" {
					wantREF = []string{ref}
				}
				if ovf != "" {
					wantOVF = []string{ovf}
				}
				check(t, name+": REF", e.lines(t, b, sqlc.TransactionTypeREF), wantREF)
				check(t, name+": OVF", e.lines(t, b, sqlc.TransactionTypeOVF), wantOVF)
				got := e.get(t, b)
				check(t, name+": TF", got.TargetFunds.StringFixed(2), tf)
				check(t, name+": refilled", got.Refilled, true)
				// Once per cycle: a manual refill is refused, an income
				// refills nothing more.
				if mode == sqlc.RefillModeManual && !errors.Is(again, refill.ErrAlreadyRefilled) {
					t.Errorf("%s: second refill: %v", name, again)
				}
				if mode == sqlc.RefillModeOnIncome && again != nil {
					t.Errorf("%s: second income: %v", name, again)
				}
				check(t, name+": TF after a second try", e.get(t, b).TargetFunds.StringFixed(2), tf)
			}
		}
	}
}

func TestManualErrors(t *testing.T) {
	e := setup(t)
	account := e.account(t, "1000")
	auto := e.bucket(t, account, false, sqlc.RefillModeAuto, "0")
	manual := e.bucket(t, account, false, sqlc.RefillModeManual, "0")

	if err := e.refills.Manual(t.Context(), e.user, auto); !errors.Is(err, refill.ErrWrongMode) {
		t.Errorf("auto bucket: %v", err)
	}
	if err := e.refills.Manual(t.Context(), e.user, "1234567890"); !errors.Is(err, refill.ErrNotFound) {
		t.Errorf("unknown bucket: %v", err)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if err := e.refills.Manual(t.Context(), bob, manual); !errors.Is(err, refill.ErrNotFound) {
		t.Errorf("bob's refill: %v", err)
	}

	// Without an active cycle.
	if err := e.cycles.Delete(t.Context(), e.user, e.nov.ID); err != nil {
		t.Fatal(err)
	}
	*e.now = at("2026-11-02T12:00:00Z")
	if _, err := e.cycles.End(t.Context(), e.user, e.oct.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := e.refills.Manual(t.Context(), e.user, manual); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("no active cycle: %v", err)
	}
}

// TestCycleRoutines ends October late: buckets without Keep funds are emptied
// just before its end, and November's start refills the Auto buckets.
func TestCycleRoutines(t *testing.T) {
	e := setup(t)
	main := e.account(t, "1000")
	poor := e.account(t, "50")
	offAuto := e.bucket(t, main, false, sqlc.RefillModeAuto, "60")
	onAuto := e.bucket(t, main, true, sqlc.RefillModeAuto, "120")
	offManual := e.bucket(t, main, false, sqlc.RefillModeManual, "40")
	onManual := e.bucket(t, main, true, sqlc.RefillModeManual, "40")
	// TF 100 but only 50 behind it: TF still goes to 0.
	underfunded := e.bucket(t, poor, false, sqlc.RefillModeManual, "100")
	if caf := e.get(t, underfunded).Caf.StringFixed(2); caf != "50.00" {
		t.Fatalf("underfunded CAF %s", caf)
	}

	*e.now = at("2026-11-02T12:00:00Z")
	ended, err := e.cycles.End(t.Context(), e.user, e.oct.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if ended.Started == nil || ended.Started.ID != e.nov.ID {
		t.Fatalf("November didn't start: %+v", ended)
	}

	for _, tc := range []struct {
		name, id, tf string
		refilled     bool
		ovf, ref     []string
	}{
		{"off, auto", offAuto, "100.00", true, []string{"-60.00"}, []string{"100.00"}},
		{"on, auto", onAuto, "150.00", true, []string{"-70.00"}, []string{"100.00"}},
		{"off, manual", offManual, "0.00", false, []string{"-40.00"}, nil},
		{"on, manual", onManual, "40.00", false, nil, nil},
		{"underfunded", underfunded, "0.00", false, []string{"-100.00"}, nil},
	} {
		b := e.get(t, tc.id)
		check(t, tc.name+": TF", b.TargetFunds.StringFixed(2), tc.tf)
		check(t, tc.name+": refilled", b.Refilled, tc.refilled)
		check(t, tc.name+": OVF", e.lines(t, tc.id, sqlc.TransactionTypeOVF), tc.ovf)
		check(t, tc.name+": REF", e.lines(t, tc.id, sqlc.TransactionTypeREF), tc.ref)
	}

	// The cycle-end OVF is dated in October, the REF at November's start.
	p, err := e.tx.List(t.Context(), e.user, transactions.Filter{BucketID: offAuto})
	if err != nil {
		t.Fatal(err)
	}
	for _, tr := range p.Items {
		switch tr.Type {
		case sqlc.TransactionTypeOVF:
			check(t, "OVF time", tr.At.UTC(), oct[1].Add(-time.Microsecond))
			check(t, "OVF cycle", tr.BucketLines[0].CycleID, e.oct.ID)
		case sqlc.TransactionTypeREF:
			check(t, "REF time", tr.At.UTC(), nov[0])
			check(t, "REF cycle", tr.BucketLines[0].CycleID, e.nov.ID)
		}
	}

	// The manual buckets can be refilled in November.
	if err := e.refills.Manual(t.Context(), e.user, offManual); err != nil {
		t.Fatal(err)
	}
	check(t, "manual refill in November", e.get(t, offManual).TargetFunds.StringFixed(2), "100.00")
}

// TestEndEarly ends October early: the OVF is dated now, and the cycle ends
// just after it.
func TestEndEarly(t *testing.T) {
	e := setup(t)
	main := e.account(t, "1000")
	b := e.bucket(t, main, false, sqlc.RefillModeAuto, "60")
	ended, err := e.cycles.End(t.Context(), e.user, e.oct.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !ended.Ended.EndAt.After(*e.now) || ended.Started == nil {
		t.Fatalf("ended %+v", ended)
	}
	check(t, "OVF", e.lines(t, b, sqlc.TransactionTypeOVF), []string{"-60.00"})
	check(t, "REF", e.lines(t, b, sqlc.TransactionTypeREF), []string{"100.00"})
	check(t, "TF", e.get(t, b).TargetFunds.StringFixed(2), "100.00")
}

func TestIncome(t *testing.T) {
	e := setup(t)
	main := e.account(t, "1000")
	other := e.account(t, "1000")
	b := e.bucket(t, main, true, sqlc.RefillModeOnIncome, "80") // REF 100, OVF 30
	elsewhere := e.bucket(t, other, false, sqlc.RefillModeOnIncome, "0")
	if _, err := e.pool.Exec(t.Context(), `UPDATE users SET preferences = '{"income_refill_rules": [{"counterparty": "Employer AS", "min_amount": "15000"}]}' WHERE id = $1`, e.user); err != nil {
		t.Fatal(err)
	}
	refilled := func(what string, want bool) {
		t.Helper()
		check(t, what+": refilled", e.get(t, b).Refilled, want)
	}
	income := func(counterparty, amount string, triggers *bool) transactions.Transaction {
		t.Helper()
		inc, err := e.income(t, main, counterparty, amount, triggers)
		if err != nil {
			t.Fatal(err)
		}
		return inc
	}

	// Rules: the counterparty ignoring case, and at least the minimum.
	check(t, "too small", income("Employer AS", "14999.99", nil).TriggersRefill, false)
	check(t, "someone else", income("Employer ASA", "20000", nil).TriggersRefill, false)
	check(t, "explicit false", income("Employer AS", "20000", ptr(false)).TriggersRefill, false)
	refilled("no rule matched", false)

	salary := income(" employer as ", "15000", nil)
	check(t, "rule matched", salary.TriggersRefill, true)
	refilled("rule matched", true)
	check(t, "TF", e.get(t, b).TargetFunds.StringFixed(2), "150.00")
	check(t, "other account untouched", e.get(t, elsewhere).Refilled, false)

	// Reversing it undoes the REF and the OVF; another income can refill.
	if _, err := e.tx.Reverse(t.Context(), e.user, salary.ID); err != nil {
		t.Fatal(err)
	}
	refilled("reversed", false)
	check(t, "TF after reversal", e.get(t, b).TargetFunds.StringFixed(2), "80.00")
	check(t, "REF after reversal", e.lines(t, b, sqlc.TransactionTypeREF), []string(nil))

	// The flag can be set afterwards, and cleared again.
	late := income("Gift", "100", nil)
	got, err := e.tx.Correct(t.Context(), e.user, late.ID, transactions.Changes{TriggersRefill: ptr(true)})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "corrected flag", got.TriggersRefill, true)
	refilled("flag set by a correction", true)
	if _, err := e.tx.Correct(t.Context(), e.user, late.ID, transactions.Changes{TriggersRefill: ptr(false)}); err != nil {
		t.Fatal(err)
	}
	refilled("flag cleared by a correction", false)

	// Moving a triggering income undoes it here and refills the new account.
	moving := income("Employer AS", "20000", nil)
	refilled("before the move", true)
	moved, err := e.tx.Correct(t.Context(), e.user, moving.ID, transactions.Changes{AccountID: &other})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "moved flag", moved.TriggersRefill, true)
	refilled("after the move", false)
	check(t, "new account refilled", e.get(t, elsewhere).Refilled, true)

	// Only incomes trigger refills.
	if _, err := e.tx.Create(t.Context(), e.user, transactions.New{
		Type: sqlc.TransactionTypeEXP, AccountID: main, Amount: dec("1"), TriggersRefill: ptr(true),
	}); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("EXP with the flag: %v", err)
	}
	exp, err := e.tx.Create(t.Context(), e.user, transactions.New{Type: sqlc.TransactionTypeEXP, AccountID: main, Amount: dec("1")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.tx.Correct(t.Context(), e.user, exp.ID, transactions.Changes{TriggersRefill: ptr(true)}); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("correcting an EXP's flag: %v", err)
	}
}

// TestIncomeOutsideCycle: an income dated before the active cycle can't
// trigger a refill. A rule skips it; an explicit flag is refused.
func TestIncomeOutsideCycle(t *testing.T) {
	e := setup(t)
	main := e.account(t, "1000")
	b := e.bucket(t, main, false, sqlc.RefillModeOnIncome, "0")
	if _, err := e.pool.Exec(t.Context(), `UPDATE users SET preferences = '{"income_refill_rules": [{"counterparty": "Employer", "min_amount": "0"}]}' WHERE id = $1`, e.user); err != nil {
		t.Fatal(err)
	}
	september := at("2026-09-25T12:00:00Z")
	inc, err := e.tx.Create(t.Context(), e.user, transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: main, Counterparty: "Employer", Amount: dec("100"), At: september,
	})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "rule, before the cycle", e.get(t, b).Refilled, false)
	if _, err := e.tx.Create(t.Context(), e.user, transactions.New{
		Type: sqlc.TransactionTypeINC, AccountID: main, Amount: dec("100"), At: september, TriggersRefill: ptr(true),
	}); !errors.Is(err, refill.ErrUnavailable) {
		t.Errorf("explicit flag before the cycle: %v", err)
	}
	if _, err := e.tx.Correct(t.Context(), e.user, inc.ID, transactions.Changes{TriggersRefill: ptr(false)}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.tx.Correct(t.Context(), e.user, inc.ID, transactions.Changes{TriggersRefill: ptr(true)}); !errors.Is(err, refill.ErrUnavailable) {
		t.Errorf("correcting the flag before the cycle: %v", err)
	}
}

// TestFinishedCycleRefillStays: reversing an income whose refill was in a
// finished cycle leaves the refill alone.
func TestFinishedCycleRefillStays(t *testing.T) {
	e := setup(t)
	main := e.account(t, "1000")
	b := e.bucket(t, main, true, sqlc.RefillModeOnIncome, "0")
	inc, err := e.income(t, main, "", "500", ptr(true))
	if err != nil {
		t.Fatal(err)
	}
	*e.now = at("2026-11-02T12:00:00Z")
	if _, err := e.cycles.End(t.Context(), e.user, e.oct.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.tx.Reverse(t.Context(), e.user, inc.ID); err != nil {
		t.Fatal(err)
	}
	check(t, "REF", e.lines(t, b, sqlc.TransactionTypeREF), []string{"100.00"})
	check(t, "TF", e.get(t, b).TargetFunds.StringFixed(2), "100.00")
	check(t, "refilled in November", e.get(t, b).Refilled, false)
}
