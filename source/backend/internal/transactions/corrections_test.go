package transactions_test

import (
	"errors"
	"testing"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func ptr[T any](v T) *T { return &v }

func (e env) correct(t *testing.T, id string, c transactions.Changes) transactions.Transaction {
	t.Helper()
	tr, err := e.svc.Correct(t.Context(), e.user, id, c)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

// balances returns the account balances and bucket TF.
func (e env) balances(t *testing.T) (map[string]decimal.Decimal, map[string]decimal.Decimal) {
	t.Helper()
	acc, err := balance.Accounts(t.Context(), e.pool, e.user)
	if err != nil {
		t.Fatal(err)
	}
	tf, err := balance.Buckets(t.Context(), e.pool, e.user)
	if err != nil {
		t.Fatal(err)
	}
	return acc, tf
}

func TestCorrectExpense(t *testing.T) {
	e := setup(t)
	groceries := ledgertest.Bucket(t, e.pool, e.user, e.account)
	fun := ledgertest.Bucket(t, e.pool, e.user, e.account)
	orig := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeEXP, Amount: dec("100"), At: now.Add(-day), Counterparty: "Rema", Tags: []string{"food"},
		Buckets: []transactions.BucketAmount{{BucketID: groceries, Amount: dec("100")}},
	})

	// 100 → 150, and the bucket part moves from Groceries to Fun.
	got := e.correct(t, orig.ID, transactions.Changes{
		Amount: ptr(dec("150")), SetBuckets: true,
		Buckets: []transactions.BucketAmount{{BucketID: fun, Amount: dec("120")}},
	})
	if want := []string{e.account + " -150.00", fun + " -120.00"}; !equal(lines(got), want) {
		t.Errorf("effective %v, want %v", lines(got), want)
	}
	if !got.Corrected || len(got.History) != 2 || !got.At.Equal(orig.At) || got.Counterparty != "Rema" {
		t.Errorf("corrected %+v", got)
	}
	adj := got.History[1]
	if len(adj.BankLines) != 1 || !adj.BankLines[0].Amount.Equal(dec("-50")) || len(adj.BucketLines) != 2 {
		t.Errorf("adjustment lines %+v", adj)
	}
	acc, tf := e.balances(t)
	if !acc[e.account].Equal(dec("-150")) || !tf[groceries].IsZero() || !tf[fun].Equal(dec("-120")) {
		t.Errorf("balance %s, TF groceries %s fun %s", acc[e.account], tf[groceries], tf[fun])
	}

	// Remove the bucket lines: through a correction's ID, which corrects the
	// original.
	got = e.correct(t, adj.ID, transactions.Changes{SetBuckets: true})
	if want := []string{e.account + " -150.00"}; !equal(lines(got), want) || got.ID != orig.ID {
		t.Errorf("without buckets %v (%s)", lines(got), got.ID)
	}

	// Counterparty and tags only: an adjustment without lines.
	got = e.correct(t, orig.ID, transactions.Changes{Counterparty: ptr("Rema 1000"), Tags: &[]string{"Groceries", "week 43"}})
	if got.Counterparty != "Rema 1000" || !equal(got.Tags, []string{"Groceries", "week 43"}) || len(got.History) != 4 ||
		len(got.History[3].BankLines)+len(got.History[3].BucketLines) != 0 {
		t.Errorf("header change %+v", got)
	}
	for name, f := range map[string]transactions.Filter{
		"new counterparty": {Counterparty: "1000"},
		"new tag":          {Tag: "week 43"},
	} {
		page, err := e.svc.List(t.Context(), e.user, f)
		if err != nil || len(page.Items) != 1 || page.Items[0].Counterparty != "Rema 1000" {
			t.Errorf("%s: %v %+v", name, err, page.Items)
		}
	}
	if page, _ := e.svc.List(t.Context(), e.user, transactions.Filter{Tag: "food"}); len(page.Items) != 0 {
		t.Errorf("old tag still matches: %+v", page.Items)
	}

	for name, c := range map[string]transactions.Changes{
		"same amount":  {Amount: ptr(dec("150"))},
		"same header":  {Counterparty: ptr(" Rema 1000 "), Tags: &[]string{"week 43", "groceries"}},
		"no fields":    {},
		"same buckets": {SetBuckets: true},
	} {
		if _, err := e.svc.Correct(t.Context(), e.user, orig.ID, c); !errors.Is(err, transactions.ErrNoChange) {
			t.Errorf("%s: %v, want ErrNoChange", name, err)
		}
	}
	other := ledgertest.Account(t, e.pool, e.user, "NOK")
	otherBucket := ledgertest.Bucket(t, e.pool, e.user, other)
	for name, c := range map[string]transactions.Changes{
		"zero amount":         {Amount: ptr(dec("0"))},
		"buckets over amount": {SetBuckets: true, Buckets: []transactions.BucketAmount{{BucketID: fun, Amount: dec("151")}}},
		"bucket from other":   {SetBuckets: true, Buckets: []transactions.BucketAmount{{BucketID: otherBucket, Amount: dec("1")}}},
		"receiving account":   {ToAccountID: &other},
	} {
		if _, err := e.svc.Correct(t.Context(), e.user, orig.ID, c); !errors.Is(err, transactions.ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
}

func TestCorrectTransferAndSystem(t *testing.T) {
	e := setup(t)
	savings := ledgertest.Account(t, e.pool, e.user, "NOK")
	trf := e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("1000"), ToAccountID: savings})
	got := e.correct(t, trf.ID, transactions.Changes{Amount: ptr(dec("1200"))})
	if want := []string{e.account + " -1200.00", savings + " 1200.00"}; !equal(lines(got), want) {
		t.Errorf("TRF %v, want %v", lines(got), want)
	}

	opb, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, Type: sqlc.TransactionTypeOPB, At: now.Add(-30 * day),
		BankLines: []ledger.BankLine{{AccountID: savings, Amount: dec("5000")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got = e.correct(t, opb.Header.ID, transactions.Changes{Amount: ptr(dec("-200"))})
	if want := []string{savings + " -200.00"}; !equal(lines(got), want) {
		t.Errorf("OPB %v, want %v", lines(got), want)
	}
	// Corrected to 0 the line disappears, and can come back.
	got = e.correct(t, opb.Header.ID, transactions.Changes{Amount: ptr(dec("0"))})
	if len(got.BankLines) != 0 {
		t.Errorf("OPB at 0: %v", lines(got))
	}
	if _, err := e.svc.Reverse(t.Context(), e.user, opb.Header.ID); !errors.Is(err, transactions.ErrNoChange) {
		t.Errorf("reverse an OPB at 0: %v", err)
	}
	got = e.correct(t, opb.Header.ID, transactions.Changes{Amount: ptr(dec("300"))})
	if want := []string{savings + " 300.00"}; !equal(lines(got), want) {
		t.Errorf("OPB back %v, want %v", lines(got), want)
	}
	if _, err := e.svc.Correct(t.Context(), e.user, opb.Header.ID, transactions.Changes{AccountID: &e.account}); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("move an OPB: %v", err)
	}

	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	ref, err := e.ledger.Create(t.Context(), e.pool, ledger.Entry{
		UserID: e.user, Type: sqlc.TransactionTypeREF, At: now,
		BucketLines: []ledger.BucketLine{{BucketID: bucket, Amount: dec("100")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Correct(t.Context(), e.user, ref.Header.ID, transactions.Changes{Counterparty: ptr("x")}); !errors.Is(err, transactions.ErrNotCorrectable) {
		t.Errorf("correct a REF: %v", err)
	}
	if _, err := e.svc.Reverse(t.Context(), e.user, ref.Header.ID); !errors.Is(err, transactions.ErrNotCorrectable) {
		t.Errorf("reverse a REF: %v", err)
	}
}

func TestReverse(t *testing.T) {
	e := setup(t)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	orig := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeINC, Amount: dec("300"), Tags: []string{"gift"},
		Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("100")}},
	})
	got, err := e.svc.Reverse(t.Context(), e.user, orig.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Reversed || len(got.BankLines)+len(got.BucketLines) != 0 || !equal(got.Tags, []string{"gift"}) {
		t.Errorf("reversed %+v", got)
	}
	acc, tf := e.balances(t)
	if !acc[e.account].IsZero() || !tf[bucket].IsZero() {
		t.Errorf("after reversal: balance %s TF %s", acc[e.account], tf[bucket])
	}
	if _, err := e.svc.Reverse(t.Context(), e.user, orig.ID); !errors.Is(err, transactions.ErrAlreadyReversed) {
		t.Errorf("reverse twice: %v", err)
	}
	if _, err := e.svc.Correct(t.Context(), e.user, orig.ID, transactions.Changes{Amount: ptr(dec("1"))}); !errors.Is(err, transactions.ErrAlreadyReversed) {
		t.Errorf("correct a reversed transaction: %v", err)
	}

	bob := authtest.NewUser(t, e.pool, "bob").ID
	other := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("5")})
	if _, err := e.svc.Reverse(t.Context(), bob, other.ID); !errors.Is(err, transactions.ErrNotFound) {
		t.Errorf("bob reverses alice's: %v", err)
	}
	if _, err := e.svc.Correct(t.Context(), bob, other.ID, transactions.Changes{Amount: ptr(dec("1"))}); !errors.Is(err, transactions.ErrNotFound) {
		t.Errorf("bob corrects alice's: %v", err)
	}
}

func TestFinishedCycleLocksBuckets(t *testing.T) {
	e := setup(t)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	orig := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeEXP, Amount: dec("100"),
		Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("80")}},
	})
	if _, err := e.pool.Exec(t.Context(), "UPDATE cycles SET state = 'finished' WHERE id = $1", e.cycle); err != nil {
		t.Fatal(err)
	}
	ledgertest.Cycle(t, e.pool, e.user, now.Add(20*day), now.Add(50*day), "active")

	// The bank amount and header can still change.
	got := e.correct(t, orig.ID, transactions.Changes{Amount: ptr(dec("90")), Counterparty: ptr("Kiwi")})
	if want := []string{e.account + " -90.00", bucket + " -80.00"}; !equal(lines(got), want) {
		t.Errorf("bank-only %v, want %v", lines(got), want)
	}
	if _, err := e.svc.Correct(t.Context(), e.user, orig.ID, transactions.Changes{Amount: ptr(dec("70"))}); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("amount below the locked bucket lines: %v", err)
	}
	for name, c := range map[string]transactions.Changes{
		"bucket amount": {SetBuckets: true, Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("50")}}},
		"remove bucket": {SetBuckets: true},
	} {
		if _, err := e.svc.Correct(t.Context(), e.user, orig.ID, c); !errors.Is(err, transactions.ErrBucketLinesLocked) {
			t.Errorf("%s: %v, want ErrBucketLinesLocked", name, err)
		}
	}
	if _, err := e.svc.Reverse(t.Context(), e.user, orig.ID); !errors.Is(err, transactions.ErrBucketLinesLocked) {
		t.Errorf("reverse: %v, want ErrBucketLinesLocked", err)
	}

	// A bank-only transaction can be reversed at any time.
	old := e.create(t, transactions.New{Type: sqlc.TransactionTypeEXP, Amount: dec("10"), At: now.Add(-40 * day)})
	if _, err := e.svc.Reverse(t.Context(), e.user, old.ID); err != nil {
		t.Errorf("reverse bank-only: %v", err)
	}
}

func TestMoveToAnotherAccount(t *testing.T) {
	e := setup(t)
	card := ledgertest.Account(t, e.pool, e.user, "NOK")
	cardBucket := ledgertest.Bucket(t, e.pool, e.user, card)
	bucket := ledgertest.Bucket(t, e.pool, e.user, e.account)
	orig := e.create(t, transactions.New{
		Type: sqlc.TransactionTypeEXP, Amount: dec("200"), At: now.Add(-day), Counterparty: "Rema", Tags: []string{"food"},
		Buckets: []transactions.BucketAmount{{BucketID: bucket, Amount: dec("200")}},
	})

	// The buckets must follow: the old one isn't funded from the card.
	if _, err := e.svc.Correct(t.Context(), e.user, orig.ID, transactions.Changes{AccountID: &card}); !errors.Is(err, transactions.ErrInvalid) {
		t.Errorf("move with the old bucket: %v", err)
	}
	moved := e.correct(t, orig.ID, transactions.Changes{
		AccountID: &card, SetBuckets: true, Buckets: []transactions.BucketAmount{{BucketID: cardBucket, Amount: dec("150")}},
	})
	if moved.ID == orig.ID || moved.Replaces != orig.ID || !moved.At.Equal(orig.At) || moved.Counterparty != "Rema" ||
		!equal(moved.Tags, []string{"food"}) {
		t.Errorf("moved %+v", moved)
	}
	if want := []string{card + " -200.00", cardBucket + " -150.00"}; !equal(lines(moved), want) {
		t.Errorf("moved lines %v, want %v", lines(moved), want)
	}
	old, err := e.svc.Get(t.Context(), e.user, orig.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !old.Reversed || old.ReplacedBy != moved.ID {
		t.Errorf("old %+v", old)
	}
	acc, tf := e.balances(t)
	if !acc[e.account].IsZero() || !acc[card].Equal(dec("-200")) || !tf[bucket].IsZero() || !tf[cardBucket].Equal(dec("-150")) {
		t.Errorf("balances %v TF %v", acc, tf)
	}

	// A transfer's receiving account.
	savings := ledgertest.Account(t, e.pool, e.user, "NOK")
	trf := e.create(t, transactions.New{Type: sqlc.TransactionTypeTRF, Amount: dec("50"), ToAccountID: card})
	got := e.correct(t, trf.ID, transactions.Changes{ToAccountID: &savings})
	if want := []string{e.account + " -50.00", savings + " 50.00"}; got.Replaces != trf.ID || !equal(lines(got), want) {
		t.Errorf("moved TRF %v (replaces %s)", lines(got), got.Replaces)
	}
}
