package transactions_test

import (
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

var (
	now = time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	day = 24 * time.Hour
)

type env struct {
	pool    *pgxpool.Pool
	svc     *transactions.Service
	ledger  *ledger.Ledger
	user    string
	account string
	cycle   string
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{})
	user := authtest.NewUser(t, pool, "alice").ID
	return env{
		pool:    pool,
		svc:     transactions.NewService(pool, l, transactions.Options{Now: func() time.Time { return now }}),
		ledger:  l,
		user:    user,
		account: ledgertest.Account(t, pool, user, "NOK"),
		cycle:   ledgertest.Cycle(t, pool, user, now.Add(-10*day), now.Add(20*day), "active"),
	}
}

func (e env) create(t *testing.T, n transactions.New) transactions.Transaction {
	t.Helper()
	if n.AccountID == "" {
		n.AccountID = e.account
	}
	tr, err := e.svc.Create(t.Context(), e.user, n)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

// lines returns a transaction's effective lines as "id amount" strings.
func lines(t transactions.Transaction) []string {
	var out []string
	for _, l := range t.BankLines {
		out = append(out, l.AccountID+" "+l.Amount.StringFixed(2))
	}
	for _, l := range t.BucketLines {
		out = append(out, l.BucketID+" "+l.Amount.StringFixed(2))
	}
	return out
}

// equal compares ignoring order: lines come in the order of their IDs, which
// start with random account and bucket IDs.
func equal(a, b []string) bool {
	return slices.Equal(slices.Sorted(slices.Values(a)), slices.Sorted(slices.Values(b)))
}

func TestCreateSigns(t *testing.T) {
	e := setup(t)
	groceries := ledgertest.Bucket(t, e.pool, e.user, e.account)
	fun := ledgertest.Bucket(t, e.pool, e.user, e.account)

	exp := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeEXP, Amount: dec("500"), Counterparty: " Rema 1000 ", Tags: []string{"food", "Food", "week 43"},
		Buckets: []transactions.BucketAmount{{BucketID: groceries, Amount: dec("400")}, {BucketID: fun, Amount: dec("100")}},
	})
	if want := []string{e.account + " -500.00", groceries + " -400.00", fun + " -100.00"}; !equal(lines(exp), want) {
		t.Errorf("EXP lines %v, want %v", lines(exp), want)
	}
	if exp.Counterparty != "Rema 1000" || len(exp.Tags) != 2 || exp.CreatedBy != e.user || !exp.At.Equal(now) {
		t.Errorf("EXP %+v", exp)
	}
	if exp.BucketLines[0].CycleID != e.cycle {
		t.Errorf("bucket line cycle %s, want %s", exp.BucketLines[0].CycleID, e.cycle)
	}

	// The remainder isn't tied to a bucket.
	inc := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeINC, Amount: dec("30000"), At: now.Add(-day),
		Buckets: []transactions.BucketAmount{{BucketID: fun, Amount: dec("250")}},
	})
	if want := []string{e.account + " 30000.00", fun + " 250.00"}; !equal(lines(inc), want) {
		t.Errorf("INC lines %v, want %v", lines(inc), want)
	}

	savings := ledgertest.Account(t, e.pool, e.user, "NOK")
	trf := e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("1000"), ToAccountID: savings})
	if want := []string{e.account + " -1000.00", savings + " 1000.00"}; !equal(lines(trf), want) {
		t.Errorf("TRF lines %v, want %v", lines(trf), want)
	}

	// A bank-only transaction needs no cycle.
	if _, err := e.pool.Exec(t.Context(), "UPDATE cycles SET state = 'finished' WHERE id = $1", e.cycle); err != nil {
		t.Fatal(err)
	}
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("10")})
}

func TestCreateRules(t *testing.T) {
	e := setup(t)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	other := ledgertest.Account(t, e.pool, e.user, "NOK")
	otherBucket := ledgertest.Bucket(t, e.pool, e.user, other)
	eur := ledgertest.Account(t, e.pool, e.user, "EUR")
	deleted := ledgertest.Bucket(t, e.pool, e.user, e.account)
	ledgertest.Delete(t, e.pool, "buckets", deleted)
	bob := authtest.NewUser(t, e.pool, "bob").ID
	bobs := ledgertest.Account(t, e.pool, bob, "NOK")

	b := func(id, amount string) []transactions.BucketAmount {
		return []transactions.BucketAmount{{BucketID: id, Amount: dec(amount)}}
	}
	for name, tc := range map[string]struct {
		n    transactions.New
		want error
	}{
		"system type":        {transactions.New{Type: sqlc.TransactionTypeREF}, transactions.ErrInvalid},
		"zero amount":        {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("0")}, transactions.ErrInvalid},
		"negative amount":    {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("-5")}, transactions.ErrInvalid},
		"3 decimals":         {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("1.005")}, transactions.ErrInvalid},
		"future":             {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), At: now.Add(time.Hour)}, transactions.ErrInvalid},
		"buckets over sum":   {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), Buckets: b(bucket, "5.01")}, transactions.ErrInvalid},
		"zero bucket amount": {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), Buckets: b(bucket, "0")}, transactions.ErrInvalid},
		"other source":       {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), Buckets: b(otherBucket, "5")}, transactions.ErrInvalid},
		"deleted bucket":     {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), Buckets: b(deleted, "5")}, transactions.ErrInvalid},
		"bob's account":      {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), AccountID: bobs}, transactions.ErrInvalid},
		"bucket twice": {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"),
			Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("1")}, {BucketID: bucket, Amount: dec("1")}}}, ledger.ErrInvalid},
		"INC to account":  {transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("5"), ToAccountID: other}, transactions.ErrInvalid},
		"TRF no target":   {transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("5")}, transactions.ErrInvalid},
		"TRF to itself":   {transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("5"), ToAccountID: e.account}, transactions.ErrInvalid},
		"TRF to EUR":      {transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("5"), ToAccountID: eur}, transactions.ErrCurrencyMismatch},
		"TRF to bob":      {transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("5"), ToAccountID: bobs}, transactions.ErrInvalid},
		"TRF with bucket": {transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("5"), ToAccountID: other, Buckets: b(bucket, "5")}, transactions.ErrInvalid},
		"before cycle":    {transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), At: now.Add(-11 * day), Buckets: b(bucket, "5")}, ledger.ErrOutsideCycle},
	} {
		if tc.n.AccountID == "" {
			tc.n.AccountID = e.account
		}
		if _, err := e.svc.Create(t.Context(), e.user, tc.n); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}

	// Within the allowed clock skew is fine.
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), At: now.Add(30 * time.Second)})

	if _, err := e.pool.Exec(t.Context(), "UPDATE cycles SET state = 'finished' WHERE id = $1", e.cycle); err != nil {
		t.Fatal(err)
	}
	n := transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5"), AccountID: e.account, Buckets: b(bucket, "5")}
	if _, err := e.svc.Create(t.Context(), e.user, n); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("no active cycle: %v", err)
	}
}

func TestCorrections(t *testing.T) {
	e := setup(t)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	orig := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeEXP, Amount: dec("100"), Tags: []string{"food"},
		Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("100")}},
	})
	// 100 corrected to 150, all of it from the bucket.
	adj, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeEXP, Correction: sqlc.CorrectionTypeAdjustment,
		ParentID: orig.ID, At: orig.At, Tags: orig.Tags, // a correction carries the effective tags
		BankLines:   []ledger.BankLine{{AccountID: e.account, Amount: dec("-50")}},
		BucketLines: []ledger.BucketLine{{BucketID: bucket, Amount: dec("-50")}},
	})
	if err != nil {
		t.Fatal(err)
	}

	got, err := e.svc.Get(t.Context(), e.user, orig.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{e.account + " -150.00", bucket + " -150.00"}; !equal(lines(got), want) {
		t.Errorf("effective lines %v, want %v", lines(got), want)
	}
	if !got.Corrected || got.Reversed || len(got.History) != 2 || got.History[1].ID != adj.Header.ID ||
		got.History[1].Correction != sqlc.CorrectionTypeAdjustment || !got.History[1].BankLines[0].Amount.Equal(dec("-50")) {
		t.Errorf("corrected %+v", got)
	}
	if len(got.Tags) != 1 || got.Tags[0] != "food" {
		t.Errorf("tags %v", got.Tags)
	}
	// A correction's ID returns its transaction.
	if viaAdj, err := e.svc.Get(t.Context(), e.user, adj.Header.ID); err != nil || viaAdj.ID != orig.ID {
		t.Errorf("get by correction ID: %v, %s", err, viaAdj.ID)
	}

	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeEXP, Correction: sqlc.CorrectionTypeReversal,
		ParentID: orig.ID, At: orig.At,
		BankLines:   []ledger.BankLine{{AccountID: e.account, Amount: dec("150")}},
		BucketLines: []ledger.BucketLine{{BucketID: bucket, Amount: dec("150")}},
	}); err != nil {
		t.Fatal(err)
	}
	page, err := e.svc.List(t.Context(), e.user, transactions.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("%d items, want only the original", len(page.Items))
	}
	if r := page.Items[0]; !r.Reversed || len(r.BankLines) != 0 || len(r.BucketLines) != 0 || r.History != nil {
		t.Errorf("reversed %+v", r)
	}

	if _, err := e.svc.Get(t.Context(), e.user, "2026102500000000"); !errors.Is(err, transactions.ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.Get(t.Context(), bob, orig.ID); !errors.Is(err, transactions.ErrNotFound) {
		t.Errorf("bob gets alice's: %v", err)
	}
}

func TestList(t *testing.T) {
	e := setup(t)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	savings := ledgertest.Account(t, e.pool, e.user, "NOK")
	ids := map[string]string{}
	add := func(name string, n transactions.New) {
		ids[name] = e.create(t, n).ID
	}
	add("salary", transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("30000"), At: now.Add(-9 * day), Counterparty: "Employer AS"})
	add("rent", transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("9000"), At: now.Add(-8 * day), Tags: []string{"Housing"}})
	add("food", transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("500"), At: now.Add(-2 * day), Counterparty: "Rema 1000",
		Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("500")}}})
	add("save", transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("2000"), At: now.Add(-day), ToAccountID: savings})
	add("old", transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("50"), At: now.Add(-40 * day), Counterparty: "100%_off"})

	list := func(f transactions.Filter) []string {
		t.Helper()
		page, err := e.svc.List(t.Context(), e.user, f)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, item := range page.Items {
			for name, id := range ids {
				if id == item.ID {
					out = append(out, name)
				}
			}
		}
		return out
	}
	for name, tc := range map[string]struct {
		f    transactions.Filter
		want []string
	}{
		"all":            {transactions.Filter{}, []string{"save", "food", "rent", "salary", "old"}},
		"types":          {transactions.Filter{Types: []sqlc.TransactionType{sqlc.TransactionTypeINC, sqlc.TransactionTypeTRF}}, []string{"save", "salary"}},
		"account":        {transactions.Filter{AccountIDs: []string{savings}}, []string{"save"}},
		"bucket":         {transactions.Filter{BucketIDs: []string{bucket}}, []string{"food"}},
		"cycle":          {transactions.Filter{CycleID: e.cycle}, []string{"save", "food", "rent", "salary"}},
		"cycle and from": {transactions.Filter{CycleID: e.cycle, From: now.Add(-3 * day)}, []string{"save", "food"}},
		"range":          {transactions.Filter{From: now.Add(-9 * day), To: now.Add(-2 * day)}, []string{"rent", "salary"}},
		"tag":            {transactions.Filter{Tags: []string{"housing"}}, []string{"rent"}},
		// Several values match any of them (#126); blank ones are dropped.
		"tags":         {transactions.Filter{Tags: []string{" HOUSING ", "nope", " "}}, []string{"rent"}},
		"no tags":      {transactions.Filter{Tags: []string{" "}}, []string{"save", "food", "rent", "salary", "old"}},
		"accounts":     {transactions.Filter{AccountIDs: []string{savings, "1111"}}, []string{"save"}},
		"buckets":      {transactions.Filter{BucketIDs: []string{"1111111111", bucket}}, []string{"food"}},
		"counterparty": {transactions.Filter{Counterparty: "rema"}, []string{"food"}},
		"wildcards":    {transactions.Filter{Counterparty: "%_"}, []string{"old"}},
	} {
		if got := list(tc.f); !slices.Equal(got, tc.want) {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}

	// Pages of 2, newest first or oldest first (#126).
	paged := func(f transactions.Filter) []string {
		t.Helper()
		var all []string
		for range 4 {
			page, err := e.svc.List(t.Context(), e.user, f)
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range page.Items {
				all = append(all, item.ID)
			}
			if page.Next == "" {
				break
			}
			f.Cursor = page.Next
		}
		return all
	}
	newest := []string{ids["save"], ids["food"], ids["rent"], ids["salary"], ids["old"]}
	if all := paged(transactions.Filter{Limit: 2}); !slices.Equal(all, newest) {
		t.Errorf("paged %v, want %v", all, newest)
	}
	oldest := slices.Clone(newest)
	slices.Reverse(oldest)
	if all := paged(transactions.Filter{Limit: 2, OldestFirst: true}); !slices.Equal(all, oldest) {
		t.Errorf("paged oldest first %v, want %v", all, oldest)
	}

	for name, f := range map[string]transactions.Filter{
		"bad cursor":    {Cursor: "nonsense"},
		"limit":         {Limit: 201},
		"unknown cycle": {CycleID: "123456000000"},
		"bad type":      {Types: []sqlc.TransactionType{"XYZ"}},
	} {
		if _, err := e.svc.List(t.Context(), e.user, f); !errors.Is(err, transactions.ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}

	bob := authtest.NewUser(t, e.pool, "bob").ID
	if page, err := e.svc.List(t.Context(), bob, transactions.Filter{}); err != nil || len(page.Items) != 0 {
		t.Errorf("bob's list %v %v", page.Items, err)
	}
}

// TestSuggestions: counterparties and tags for autocompletion.
func TestSuggestions(t *testing.T) {
	e := setup(t)
	groceries := ledgertest.Bucket(t, e.pool, e.user, e.account)
	exp := func(counterparty string, at time.Time, tags []string, bucket string) transactions.Transaction {
		t.Helper()
		n := transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("100"), At: at, Counterparty: counterparty, Tags: tags}
		if bucket != "" {
			n.Buckets = []transactions.BucketAmount{{BucketID: bucket, Amount: dec("100")}}
		}
		return e.create(t, n)
	}
	exp("Rema 1000", now.Add(-3*day), []string{"food"}, groceries)
	exp("rema 1000", now.Add(-1*day), []string{"food", "weekly"}, "")
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("500"), At: now.Add(-2 * day), Counterparty: "Employer AS", Tags: []string{"salary"}})
	coop := exp("Coop", now.Add(-4*day), []string{"coop"}, groceries)
	// A correction changes the counterparty and tags; the newest header wins.
	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeEXP, Correction: sqlc.CorrectionTypeAdjustment,
		ParentID: coop.ID, At: coop.At, Counterparty: "Coop Mega", Tags: []string{"groceries"},
	}); err != nil {
		t.Fatal(err)
	}
	// Reversed: not suggested.
	kiwi := exp("Kiwi", now.Add(-day/2), nil, "")
	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeEXP, Correction: sqlc.CorrectionTypeReversal,
		ParentID: kiwi.ID, At: kiwi.At, BankLines: []ledger.BankLine{{AccountID: e.account, Amount: dec("100")}},
	}); err != nil {
		t.Fatal(err)
	}
	// A transfer has no counterparty to suggest.
	other := ledgertest.Account(t, e.pool, e.user, "NOK")
	e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("10"), ToAccountID: other, Counterparty: "Me"})
	if _, err := e.pool.Exec(t.Context(), "INSERT INTO tags (user_id, name) VALUES ($1, 'archive')", e.user); err != nil {
		t.Fatal(err)
	}

	names := func(list []transactions.Counterparty) []string {
		out := []string{}
		for _, c := range list {
			out = append(out, c.Counterparty)
		}
		return out
	}
	cps := func(q string, typ sqlc.TransactionType) []transactions.Counterparty {
		t.Helper()
		list, err := e.svc.Counterparties(t.Context(), e.user, q, typ, 0)
		if err != nil {
			t.Fatal(err)
		}
		return list
	}
	all := cps("", "")
	if got, want := names(all), []string{"rema 1000", "Employer AS", "Coop Mega"}; !slices.Equal(got, want) {
		t.Fatalf("counterparties %v, want %v", got, want)
	}
	if r := all[0]; r.Type != sqlc.TransactionTypeEXP || r.AccountID != e.account || !r.At.Equal(now.Add(-1*day)) ||
		!slices.Equal(r.Tags, []string{"food", "weekly"}) || len(r.BucketIDs) != 0 {
		t.Errorf("newest Rema 1000 %+v", r)
	}
	if c := all[2]; !slices.Equal(c.Tags, []string{"groceries"}) || !slices.Equal(c.BucketIDs, []string{groceries}) {
		t.Errorf("corrected Coop %+v", c)
	}
	if got := names(cps("", sqlc.TransactionTypeINC)); !slices.Equal(got, []string{"Employer AS"}) {
		t.Errorf("incomes %v", got)
	}
	if got := names(cps("MEGA", "")); !slices.Equal(got, []string{"Coop Mega"}) {
		t.Errorf("q=MEGA %v", got)
	}
	if got := names(cps("%", "")); len(got) != 0 {
		t.Errorf("q=%% is literal: %v", got)
	}
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if list, err := e.svc.Counterparties(t.Context(), bob, "", "", 0); err != nil || len(list) != 0 {
		t.Errorf("bob: %v, %v", list, err)
	}
	if _, err := e.svc.Counterparties(t.Context(), e.user, "", sqlc.TransactionTypeTRF, 0); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("transfers: %v", err)
	}
	if _, err := e.svc.Counterparties(t.Context(), e.user, "", "", transactions.MaxCounterpartyLimit+1); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("limit: %v", err)
	}
	if list, err := e.svc.Counterparties(t.Context(), e.user, "", "", 1); err != nil || len(list) != 1 {
		t.Errorf("limit 1: %v, %v", list, err)
	}

	tags := func(q string) []string {
		t.Helper()
		list, err := e.svc.Tags(t.Context(), e.user, q, 0)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, tag := range list {
			out = append(out, tag.Name)
		}
		return out
	}
	if got, want := tags(""), []string{"food", "weekly", "salary", "coop", "groceries", "archive"}; !slices.Equal(got, want) {
		t.Errorf("tags %v, want %v", got, want)
	}
	if got, want := tags("O"), []string{"food", "coop", "groceries"}; !slices.Equal(got, want) {
		t.Errorf("tags with o %v, want %v", got, want)
	}
	list, err := e.svc.Tags(t.Context(), e.user, "archive", 0)
	if err != nil || len(list) != 1 || !list[0].LastUsed.IsZero() {
		t.Errorf("unused tag %+v, %v", list, err)
	}
	if list, err := e.svc.Tags(t.Context(), e.user, "food", 0); err != nil || !list[0].LastUsed.Equal(now.Add(-1*day)) {
		t.Errorf("food last used %+v, %v", list, err)
	}
	if _, err := e.svc.Tags(t.Context(), e.user, "", transactions.MaxTagLimit+1); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("tag limit: %v", err)
	}
}

// TestSummary: counted and summed as a report's section summary (#203).
func TestSummary(t *testing.T) {
	e := setup(t)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	savings := ledgertest.Account(t, e.pool, e.user, "NOK")
	euro := ledgertest.Account(t, e.pool, e.user, "EUR")
	e.create(t, transactions.New{Type: sqlc.TransactionTypeINC, Amount: dec("30000"), At: now.Add(-9 * day)})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("9000"), At: now.Add(-8 * day), Tags: []string{"Housing"}})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("500"), At: now.Add(-2 * day),
		Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("500")}}})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("2000"), At: now.Add(-day), ToAccountID: savings})
	e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("20"), At: now.Add(-day / 2), AccountID: euro})
	// 100 corrected to 150 counts as 150; a reversed one doesn't count.
	corrected := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("100"), At: now.Add(-4 * day)})
	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeEXP, Correction: sqlc.CorrectionTypeAdjustment,
		ParentID: corrected.ID, At: corrected.At,
		BankLines: []ledger.BankLine{{AccountID: e.account, Amount: dec("-50")}},
	}); err != nil {
		t.Fatal(err)
	}
	reversed := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("70"), At: now.Add(-3 * day)})
	if _, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, CreatedBy: e.user, Type: sqlc.TransactionTypeEXP, Correction: sqlc.CorrectionTypeReversal,
		ParentID: reversed.ID, At: reversed.At,
		BankLines: []ledger.BankLine{{AccountID: e.account, Amount: dec("70")}},
	}); err != nil {
		t.Fatal(err)
	}

	summary := func(f transactions.Filter) string {
		t.Helper()
		s, err := e.svc.Summary(t.Context(), e.user, f)
		if err != nil {
			t.Fatal(err)
		}
		out := fmt.Sprint(s.Count)
		for _, x := range s.Totals {
			out += fmt.Sprintf(" %s %s/%s/%s", x.Currency, x.In.StringFixed(2), x.Out.StringFixed(2), x.Net.StringFixed(2))
		}
		return out
	}
	for name, tc := range map[string]struct {
		f    transactions.Filter
		want string
	}{
		// The transfer counts, but adds nothing seen from neither account.
		// Currencies come newest first: the euro expense is the newest.
		"all": {transactions.Filter{}, "6 EUR 0.00/20.00/-20.00 NOK 30000.00/9650.00/20350.00"},
		// Seen from one account, the transfer is out of it, or into savings.
		"account": {transactions.Filter{AccountIDs: []string{e.account}}, "5 NOK 30000.00/11650.00/18350.00"},
		"savings": {transactions.Filter{AccountIDs: []string{savings}}, "1 NOK 2000.00/0.00/2000.00"},
		"both":    {transactions.Filter{AccountIDs: []string{e.account, savings}}, "5 NOK 30000.00/9650.00/20350.00"},
		// With bank lines, those count, as a row shows them.
		"bucket": {transactions.Filter{BucketIDs: []string{bucket}}, "1 NOK 0.00/500.00/-500.00"},
		"tag":    {transactions.Filter{Tags: []string{"housing"}}, "1 NOK 0.00/9000.00/-9000.00"},
		// To is exclusive: not the transfer a day ago.
		"range": {transactions.Filter{From: now.Add(-5 * day), To: now.Add(-day)}, "2 NOK 0.00/650.00/-650.00"},
		// The list's limit, cursor and order don't matter.
		"paging":   {transactions.Filter{Limit: 1, Cursor: "nonsense", OldestFirst: true}, "6 EUR 0.00/20.00/-20.00 NOK 30000.00/9650.00/20350.00"},
		"reversed": {transactions.Filter{Reversed: new(true)}, "0"},
	} {
		if got := summary(tc.f); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
	if _, err := e.svc.Summary(t.Context(), e.user, transactions.Filter{Types: []sqlc.TransactionType{"XYZ"}}); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("bad type: %v", err)
	}

	// More than a page of them.
	bob := authtest.NewUser(t, e.pool, "bob").ID
	account := ledgertest.Account(t, e.pool, bob, "NOK")
	for i := range transactions.MaxLimit + 1 {
		if _, err := e.svc.Create(t.Context(), bob, transactions.New{
			Type: sqlc.TransactionTypeEXP, Amount: dec("1"), AccountID: account, At: now.Add(-time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	s, err := e.svc.Summary(t.Context(), bob, transactions.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if s.Count != transactions.MaxLimit+1 || len(s.Totals) != 1 || !s.Totals[0].Out.Equal(dec("201")) {
		t.Errorf("bob's summary %+v", s)
	}
}
