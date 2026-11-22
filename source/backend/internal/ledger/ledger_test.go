package ledger_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}

// October 2026 in Oslo: from 1 October 00:00 (+02:00) up to 1 November
// 00:00 (+01:00, after summer time ends).
var octStart, octEnd = at("2026-09-30T22:00:00Z"), at("2026-10-31T23:00:00Z")

// world is one user with two accounts, two buckets on the first account and
// an active cycle for October 2026.
type world struct {
	pool               *pgxpool.Pool
	user               string
	acc1, acc2         string
	bucket1, bucket2   string
	cycle              string
	ledger             *ledger.Ledger
	otherUser, otherAc string
	otherBucket        string
}

func setup(t *testing.T) world {
	t.Helper()
	pool := testdb.New(t)
	w := world{pool: pool, ledger: ledger.New(ledger.Options{})}
	w.user = authtest.NewUser(t, pool, "alice").ID
	w.acc1 = ledgertest.Account(t, pool, w.user, "")
	w.acc2 = ledgertest.Account(t, pool, w.user, "")
	w.bucket1 = ledgertest.Bucket(t, pool, w.user, w.acc1)
	w.bucket2 = ledgertest.Bucket(t, pool, w.user, w.acc1)
	w.cycle = ledgertest.Cycle(t, pool, w.user, octStart, octEnd, "active")
	w.otherUser = authtest.NewUser(t, pool, "bob").ID
	w.otherAc = ledgertest.Account(t, pool, w.otherUser, "")
	w.otherBucket = ledgertest.Bucket(t, pool, w.otherUser, w.otherAc)
	ledgertest.Cycle(t, pool, w.otherUser, octStart, octEnd, "active")
	return w
}

func (w world) entry(typ sqlc.TransactionType) ledger.Entry {
	return ledger.Entry{UserID: w.user, CreatedBy: w.user, Type: typ, At: at("2026-10-15T10:00:00Z")}
}

func bank(account, amount string) []ledger.BankLine {
	return []ledger.BankLine{{AccountID: account, Amount: dec(amount)}}
}

func buckets(pairs ...string) []ledger.BucketLine {
	var lines []ledger.BucketLine
	for i := 0; i < len(pairs); i += 2 {
		lines = append(lines, ledger.BucketLine{BucketID: pairs[i], Amount: dec(pairs[i+1])})
	}
	return lines
}

func count(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRecordExpense(t *testing.T) {
	w := setup(t)
	e := w.entry(sqlc.TransactionTypeEXP)
	// 16 October 00:30 in Oslo is 15 October 22:30 UTC; the ID uses the UTC date.
	e.At = time.Date(2026, 10, 16, 0, 30, 0, 123456789, time.FixedZone("CEST", 2*3600))
	e.Counterparty = "  Rema 1000 "
	e.Tags = []string{"food", " Groceries", "FOOD", ""}
	e.BankLines = bank(w.acc1, "-250.40")
	e.BucketLines = buckets(w.bucket1, "-200.40", w.bucket2, "-50")

	tx, err := w.ledger.Create(t.Context(), w.pool, e)
	if err != nil {
		t.Fatal(err)
	}
	h := tx.Header
	if !strings.HasPrefix(h.ID, "20261015") || len(h.ID) != 16 {
		t.Errorf("ID %s doesn't start with the UTC transaction date", h.ID)
	}
	if !h.TransactionAt.Equal(at("2026-10-15T22:30:00.123456Z")) || h.Counterparty != "Rema 1000" ||
		h.CorrectionType != sqlc.CorrectionTypeNone || h.ParentID.Valid || h.CreatedBy.String != w.user {
		t.Errorf("unexpected header %+v", h)
	}
	if strings.Join(tx.Tags, ",") != "food,Groceries" {
		t.Errorf("tags %q", tx.Tags)
	}
	if len(tx.BankLines) != 1 || !strings.HasPrefix(tx.BankLines[0].ID, w.acc1) || !tx.BankLines[0].Amount.Equal(dec("-250.40")) {
		t.Errorf("bank lines %+v", tx.BankLines)
	}
	for _, l := range tx.BucketLines {
		if l.CycleID != w.cycle || !strings.HasPrefix(l.ID, l.BucketID) || len(l.ID) != 24 {
			t.Errorf("bucket line %+v", l)
		}
	}

	got, err := ledger.Get(t.Context(), w.pool, w.user, h.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Header.ID != h.ID || len(got.BankLines) != 1 || len(got.BucketLines) != 2 ||
		strings.Join(got.Tags, ",") != "food,Groceries" {
		t.Errorf("Get returned %+v", got)
	}
	if _, err := ledger.Get(t.Context(), w.pool, w.otherUser, h.ID); !errors.Is(err, ledger.ErrNotFound) {
		t.Errorf("another user's Get: %v", err)
	}

	// Tags are reused, whatever their case.
	e.Tags = []string{"Food"}
	e.BucketLines = nil
	tx2, err := w.ledger.Create(t.Context(), w.pool, e)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(tx2.Tags, ",") != "food" || count(t, w.pool, "tags") != 2 {
		t.Errorf("tag not reused: %q, %d tags", tx2.Tags, count(t, w.pool, "tags"))
	}
}

func TestLineShapes(t *testing.T) {
	w := setup(t)
	type tc struct {
		typ    sqlc.TransactionType
		bank   []ledger.BankLine
		bucket []ledger.BucketLine
		ok     bool
	}
	twoBank := append(bank(w.acc1, "-10"), bank(w.acc2, "10")...)
	for _, c := range []tc{
		{sqlc.TransactionTypeOPB, bank(w.acc1, "1000"), nil, true},
		{sqlc.TransactionTypeOPB, nil, nil, false},
		{sqlc.TransactionTypeOPB, bank(w.acc1, "1000"), buckets(w.bucket1, "1"), false},
		{sqlc.TransactionTypeBLA, bank(w.acc1, "-3.50"), nil, true},
		{sqlc.TransactionTypeINC, bank(w.acc1, "500"), nil, true},
		{sqlc.TransactionTypeINC, bank(w.acc1, "500"), buckets(w.bucket1, "100", w.bucket2, "100"), true},
		{sqlc.TransactionTypeINC, twoBank, nil, false},
		{sqlc.TransactionTypeEXP, nil, buckets(w.bucket1, "-1"), false},
		{sqlc.TransactionTypeTRF, twoBank, nil, true},
		{sqlc.TransactionTypeTRF, bank(w.acc1, "-10"), nil, false},
		{sqlc.TransactionTypeTRF, append(bank(w.acc1, "-10"), bank(w.acc1, "10")...), nil, false},
		{sqlc.TransactionTypeTRF, twoBank, buckets(w.bucket1, "1"), false},
		{sqlc.TransactionTypeOPF, nil, buckets(w.bucket1, "300"), true},
		{sqlc.TransactionTypeOPF, nil, buckets(w.bucket1, "300", w.bucket2, "1"), false},
		{sqlc.TransactionTypeREF, nil, buckets(w.bucket1, "300"), true},
		{sqlc.TransactionTypeREF, bank(w.acc1, "300"), buckets(w.bucket1, "300"), false},
		{sqlc.TransactionTypeBUA, nil, buckets(w.bucket1, "-20"), true},
		{sqlc.TransactionTypeOVF, nil, buckets(w.bucket1, "-20"), true},
		{sqlc.TransactionTypeOVF, nil, nil, false},
		{sqlc.TransactionTypeBAT, nil, buckets(w.bucket1, "-20", w.bucket2, "20"), true},
		{sqlc.TransactionTypeBAT, nil, buckets(w.bucket1, "-20"), false},
		{sqlc.TransactionTypeBAT, nil, buckets(w.bucket1, "-20", w.bucket1, "20"), false},
		{"XYZ", bank(w.acc1, "1"), nil, false},
	} {
		e := w.entry(c.typ)
		e.BankLines, e.BucketLines = c.bank, c.bucket
		_, err := w.ledger.Create(t.Context(), w.pool, e)
		switch {
		case c.ok && err != nil:
			t.Errorf("%s with %d bank, %d bucket lines: %v", c.typ, len(c.bank), len(c.bucket), err)
		case !c.ok && !errors.Is(err, ledger.ErrInvalid):
			t.Errorf("%s with %d bank, %d bucket lines: got %v, want ErrInvalid", c.typ, len(c.bank), len(c.bucket), err)
		}
	}

	e := w.entry(sqlc.TransactionTypeINP)
	e.BankLines = twoBank
	if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrUnsupported) {
		t.Errorf("INP: %v", err)
	}
}

func TestAmounts(t *testing.T) {
	w := setup(t)
	for _, amount := range []string{"0", "0.00", "1.005", "1000000000000"} {
		e := w.entry(sqlc.TransactionTypeINC)
		e.BankLines = bank(w.acc1, amount)
		if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrInvalid) {
			t.Errorf("amount %s: %v", amount, err)
		}
	}

	// Amounts are exact: 0.10 + 0.20 is 0.30 in the database.
	for _, amount := range []string{"0.10", "0.20"} {
		e := w.entry(sqlc.TransactionTypeINC)
		e.BankLines = bank(w.acc2, amount)
		if _, err := w.ledger.Create(t.Context(), w.pool, e); err != nil {
			t.Fatal(err)
		}
	}
	var sum decimal.Decimal
	if err := w.pool.QueryRow(t.Context(), "SELECT sum(amount) FROM bank_transactions WHERE account_id = $1", w.acc2).Scan(&sum); err != nil {
		t.Fatal(err)
	}
	if !sum.Equal(dec("0.30")) {
		t.Errorf("sum is %s", sum)
	}
}

func TestForeignCurrency(t *testing.T) {
	w := setup(t)
	e := w.entry(sqlc.TransactionTypeEXP)
	e.BankLines = []ledger.BankLine{{
		AccountID: w.acc1,
		Amount:    dec("-115.32"),
		Original:  &ledger.Foreign{Amount: dec("-10.00"), Currency: "EUR"},
	}}
	tx, err := w.ledger.Create(t.Context(), w.pool, e)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ledger.Get(t.Context(), w.pool, w.user, tx.Header.ID)
	if err != nil {
		t.Fatal(err)
	}
	l := got.BankLines[0]
	if !l.OriginalAmount.Decimal.Equal(dec("-10")) || l.OriginalCurrency.String != "EUR" || !l.ExchangeRate.Decimal.Equal(dec("11.532")) {
		t.Errorf("foreign fields: %+v", l)
	}

	e.BankLines[0].Original.Currency = "eur"
	if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrInvalid) {
		t.Errorf("lower-case currency: %v", err)
	}
}

func TestOwnership(t *testing.T) {
	w := setup(t)
	deletedAcc := ledgertest.Account(t, w.pool, w.user, "")
	ledgertest.Delete(t, w.pool, "bank_accounts", deletedAcc)
	deletedBucket := ledgertest.Bucket(t, w.pool, w.user, w.acc1)
	ledgertest.Delete(t, w.pool, "buckets", deletedBucket)

	for name, e := range map[string]ledger.Entry{
		"other user's account": {BankLines: bank(w.otherAc, "1")},
		"deleted account":      {BankLines: bank(deletedAcc, "1")},
		"unknown account":      {BankLines: bank(ledgertest.UnusedAccountID(t, w.pool), "1")},
		"other user's bucket":  {BankLines: bank(w.acc1, "1"), BucketLines: buckets(w.otherBucket, "1")},
		"deleted bucket":       {BankLines: bank(w.acc1, "1"), BucketLines: buckets(deletedBucket, "1")},
	} {
		entry := w.entry(sqlc.TransactionTypeINC)
		entry.BankLines, entry.BucketLines = e.BankLines, e.BucketLines
		if _, err := w.ledger.Create(t.Context(), w.pool, entry); !errors.Is(err, ledger.ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if n := count(t, w.pool, "transaction_headers"); n != 0 {
		t.Errorf("%d headers left behind", n)
	}
}

func TestCycles(t *testing.T) {
	w := setup(t)
	e := w.entry(sqlc.TransactionTypeREF)
	e.BucketLines = buckets(w.bucket1, "100")

	// The cycle includes its start and ends just before its end.
	for _, d := range []time.Time{octStart, octEnd.Add(-time.Microsecond)} {
		e.At = d
		if _, err := w.ledger.Create(t.Context(), w.pool, e); err != nil {
			t.Errorf("%s, inside the cycle: %v", d, err)
		}
	}
	for _, d := range []time.Time{octStart.Add(-time.Microsecond), octEnd} {
		e.At = d
		if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrOutsideCycle) {
			t.Errorf("%s, outside the cycle: %v", d, err)
		}
	}

	// Bank-only transactions don't need a cycle; bucket lines do.
	carol := authtest.NewUser(t, w.pool, "carol").ID
	acc := ledgertest.Account(t, w.pool, carol, "")
	b := ledgertest.Bucket(t, w.pool, carol, acc)
	ledgertest.Cycle(t, w.pool, carol, at("2026-08-31T22:00:00Z"), octStart, "finished")
	ledgertest.Cycle(t, w.pool, carol, octEnd, at("2026-11-30T23:00:00Z"), "future")
	inc := ledger.Entry{UserID: carol, Type: sqlc.TransactionTypeINC, At: at("2026-10-15T10:00:00Z"), BankLines: bank(acc, "100")}
	if _, err := w.ledger.Create(t.Context(), w.pool, inc); err != nil {
		t.Errorf("bank-only without a cycle: %v", err)
	}
	inc.BucketLines = buckets(b, "100")
	if _, err := w.ledger.Create(t.Context(), w.pool, inc); !errors.Is(err, ledger.ErrNoActiveCycle) {
		t.Errorf("bucket lines without an active cycle: %v", err)
	}
}

func TestCorrections(t *testing.T) {
	w := setup(t)
	orig := w.entry(sqlc.TransactionTypeEXP)
	orig.BankLines = bank(w.acc1, "-100")
	orig.BucketLines = buckets(w.bucket1, "-100")
	parent, err := w.ledger.Create(t.Context(), w.pool, orig)
	if err != nil {
		t.Fatal(err)
	}

	adj := w.entry(sqlc.TransactionTypeEXP)
	adj.Correction = sqlc.CorrectionTypeAdjustment
	adj.ParentID = parent.Header.ID
	adj.BankLines = bank(w.acc1, "-50") // bank line only: 100 → 150
	child, err := w.ledger.Create(t.Context(), w.pool, adj)
	if err != nil {
		t.Fatal(err)
	}
	if child.Header.ParentID.String != parent.Header.ID || child.Header.CorrectionType != sqlc.CorrectionTypeAdjustment {
		t.Errorf("unexpected correction header %+v", child.Header)
	}

	// An adjustment without lines changes only the header fields.
	headerOnly := adj
	headerOnly.BankLines, headerOnly.Counterparty = nil, "New name"
	if _, err := w.ledger.Create(t.Context(), w.pool, headerOnly); err != nil {
		t.Errorf("adjustment without lines: %v", err)
	}

	for name, mutate := range map[string]func(e *ledger.Entry){
		"reversal without lines": func(e *ledger.Entry) { e.Correction, e.BankLines = sqlc.CorrectionTypeReversal, nil },
		"correction replaces":    func(e *ledger.Entry) { e.ReplacesID = parent.Header.ID },
		"no parent":              func(e *ledger.Entry) { e.ParentID = "" },
		"parent is correction":   func(e *ledger.Entry) { e.ParentID = child.Header.ID },
		"different type":         func(e *ledger.Entry) { e.Type = sqlc.TransactionTypeINC },
		"too many bank lines":    func(e *ledger.Entry) { e.BankLines = append(e.BankLines, bank(w.acc2, "1")...) },
		"original with parent":   func(e *ledger.Entry) { e.Correction = sqlc.CorrectionTypeNone },
	} {
		e := adj
		mutate(&e)
		if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}

	other := adj
	other.UserID = w.otherUser
	other.BankLines = bank(w.otherAc, "-1")
	if _, err := w.ledger.Create(t.Context(), w.pool, other); !errors.Is(err, ledger.ErrNotFound) {
		t.Errorf("correcting another user's transaction: %v", err)
	}
}

func TestAfterRecord(t *testing.T) {
	w := setup(t)
	var seen []string
	boom := errors.New("boom")
	fail := false
	l := ledger.New(ledger.Options{AfterRecord: func(ctx context.Context, tx pgx.Tx, t *ledger.Transaction) error {
		seen = append(seen, t.Header.ID)
		// The hook sees the rows in its transaction.
		var n int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM bank_transactions WHERE transaction_id = $1", t.Header.ID).Scan(&n); err != nil || n != 1 {
			return errors.New("rows not visible to the hook")
		}
		if fail {
			return boom
		}
		return nil
	}})

	e := w.entry(sqlc.TransactionTypeINC)
	e.BankLines = bank(w.acc1, "100")
	e.BucketLines = buckets(w.bucket1, "100")
	e.Tags = []string{"salary"}
	tx, err := l.Create(t.Context(), w.pool, e)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || seen[0] != tx.Header.ID {
		t.Errorf("hook saw %v", seen)
	}

	// A failing hook rolls back everything, including new tags.
	fail = true
	e.Tags = []string{"bonus"}
	if _, err := l.Create(t.Context(), w.pool, e); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	for table, want := range map[string]int{
		"transaction_headers": 1, "bank_transactions": 1, "bucket_transactions": 1, "tags": 1, "transaction_tags": 1,
	} {
		if n := count(t, w.pool, table); n != want {
			t.Errorf("%s: %d rows, want %d", table, n, want)
		}
	}
}

func savingsLine(holder, account, amount string) []ledger.SavingsLine {
	return []ledger.SavingsLine{{HolderID: holder, AccountID: account, Amount: dec(amount)}}
}

// TestSavingsLines: the shapes of the savings types (#231), whose holders
// must be the user's and live, and the cycle a savings line gets.
func TestSavingsLines(t *testing.T) {
	w := setup(t)
	target := ledgertest.Target(t, w.pool, w.user, w.acc2)
	twoBank := append(bank(w.acc1, "-10"), bank(w.acc2, "10")...)
	held := savingsLine(target, w.acc1, "10")
	type tc struct {
		typ     sqlc.TransactionType
		bank    []ledger.BankLine
		bucket  []ledger.BucketLine
		savings []ledger.SavingsLine
		ok      bool
	}
	for i, c := range []tc{
		{sqlc.TransactionTypeSVR, nil, nil, held, true},
		{sqlc.TransactionTypeSVR, nil, nil, nil, false},
		{sqlc.TransactionTypeSVR, bank(w.acc1, "10"), nil, held, false},
		{sqlc.TransactionTypeSVR, nil, nil, append(held, savingsLine(target, w.acc2, "1")...), false},
		{sqlc.TransactionTypeSVC, nil, nil, savingsLine(target, w.acc1, "-10"), true},
		{sqlc.TransactionTypeSVC, nil, buckets(w.bucket1, "1"), held, false},
		{sqlc.TransactionTypeTRF, twoBank, nil, savingsLine(target, w.acc1, "-10"), true},
		{sqlc.TransactionTypeTRF, twoBank, nil, append(held, held...), false},
		{sqlc.TransactionTypeSVB, nil, buckets(w.bucket1, "10"), nil, true},
		{sqlc.TransactionTypeSVB, twoBank, buckets(w.bucket1, "10"), savingsLine(target, w.acc2, "-10"), true},
		{sqlc.TransactionTypeSVB, bank(w.acc1, "10"), buckets(w.bucket1, "10"), nil, false},
		{sqlc.TransactionTypeSVB, nil, nil, held, false},
		{sqlc.TransactionTypeSVB, nil, buckets(w.bucket1, "10", w.bucket2, "1"), nil, false},
		{sqlc.TransactionTypeINC, bank(w.acc1, "10"), nil, held, false},
		{sqlc.TransactionTypeBUA, nil, buckets(w.bucket1, "10"), held, false},
		{sqlc.TransactionTypeSVR, nil, nil, savingsLine(target, w.otherAc, "10"), false},
	} {
		e := w.entry(c.typ)
		e.BankLines, e.BucketLines, e.SavingsLines = c.bank, c.bucket, c.savings
		_, err := w.ledger.Create(t.Context(), w.pool, e)
		switch {
		case c.ok && err != nil:
			t.Errorf("%d: %s: %v", i, c.typ, err)
		case !c.ok && err == nil:
			t.Errorf("%d: %s: recorded, want an error", i, c.typ)
		}
	}

	// Someone else's holder, or a deleted one, isn't found.
	theirs := ledgertest.Target(t, w.pool, w.otherUser, w.otherAc)
	e := w.entry(sqlc.TransactionTypeSVR)
	e.SavingsLines = savingsLine(theirs, w.acc1, "10")
	if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrNotFound) {
		t.Errorf("another user's target: %v", err)
	}
	gone := ledgertest.Target(t, w.pool, w.user, w.acc1)
	ledgertest.Delete(t, w.pool, "savings_holders", gone)
	e.SavingsLines = savingsLine(gone, w.acc2, "10")
	if _, err := w.ledger.Create(t.Context(), w.pool, e); !errors.Is(err, ledger.ErrNotFound) {
		t.Errorf("a deleted target: %v", err)
	}

	// A savings line gets the cycle its time falls in, or none, and needs no
	// active cycle.
	e.SavingsLines = held
	for _, c := range []struct {
		at    time.Time
		cycle string
	}{{at("2026-10-15T10:00:00Z"), w.cycle}, {octEnd.Add(time.Hour), ""}} {
		e.At = c.at
		tx, err := w.ledger.Create(t.Context(), w.pool, e)
		if err != nil {
			t.Fatalf("%s: %v", c.at, err)
		}
		if got := tx.SavingsLines[0].CycleID.String; got != c.cycle {
			t.Errorf("%s: cycle %q, want %q", c.at, got, c.cycle)
		}
		got, err := ledger.Get(t.Context(), w.pool, w.user, tx.Header.ID)
		if err != nil || len(got.SavingsLines) != 1 || !got.SavingsLines[0].Amount.Equal(dec("10")) {
			t.Errorf("read back: %v %+v", err, got)
		}
	}
}
