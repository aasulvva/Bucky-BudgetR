// Package transactions creates and lists the transactions a user enters
// (spec §5): income (INC), expenses (EXP) and transfers (TRF).
//
// It adds the rules for these types on top of the ledger: signs, which
// buckets a transaction may use, and dates. When reading, it merges each
// transaction with its corrections, so callers see the effective lines.
package transactions

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

var (
	// ErrNotFound means the transaction doesn't exist or belongs to another
	// user.
	ErrNotFound = errors.New("not found")
	// ErrInvalid means the input breaks a rule. The message says which.
	ErrInvalid = errors.New("invalid")
	// ErrCurrencyMismatch means a transfer's accounts have different
	// currencies.
	ErrCurrencyMismatch = errors.New("the accounts have different currencies")
)

const (
	// ClockSkew is how far after the server's now a transaction time may be,
	// to allow for a client clock that runs a little fast.
	ClockSkew = time.Minute
	// DefaultLimit and MaxLimit are the page sizes of List.
	DefaultLimit = 50
	MaxLimit     = 200
)

// New is a transaction the user enters. Amounts are positive; the sign comes
// from the type (INC adds, EXP takes away, TRF moves from AccountID to
// ToAccountID).
type New struct {
	Type sqlc.TransactionType
	// At defaults to now. It can't be in the future.
	At           time.Time
	Counterparty string
	Tags         []string
	AccountID    string
	// ToAccountID is the receiving account of a transfer.
	ToAccountID string
	Amount      decimal.Decimal
	// Buckets are the parts of an income or expense that go to or come from
	// buckets. Each bucket must be funded from AccountID, and together they
	// can't exceed Amount; the rest isn't tied to a bucket.
	Buckets []BucketAmount
}

// BucketAmount is a positive amount for one bucket.
type BucketAmount struct {
	BucketID string
	Amount   decimal.Decimal
}

// Transaction is an original transaction merged with its corrections.
type Transaction struct {
	ID           string
	Type         sqlc.TransactionType
	At           time.Time
	Counterparty string
	Tags         []string
	CreatedAt    time.Time
	// CreatedBy is the user who entered it, or "" for the system.
	CreatedBy string
	// Corrected is set when it has adjustments, Reversed when it has been
	// reversed.
	Corrected, Reversed bool
	// Replaces is the transaction this one replaced when it was moved to
	// another account; ReplacedBy is the one that replaced it.
	Replaces, ReplacedBy string
	// BankLines and BucketLines are the effective amounts: each account's or
	// bucket's lines summed over the original and its corrections. Lines
	// that sum to zero are left out.
	BankLines   []BankLine
	BucketLines []BucketLine
	// History is the original and its corrections, oldest first. Only Get
	// fills it.
	History []Version
}

// BankLine is an amount on an account.
type BankLine struct {
	AccountID string
	Amount    decimal.Decimal
}

// BucketLine is an amount on a bucket, in a cycle.
type BucketLine struct {
	BucketID string
	CycleID  string
	Amount   decimal.Decimal
}

// Version is one recorded transaction in a transaction's history: the
// original or a correction, with its own lines.
type Version struct {
	ID          string
	Correction  sqlc.CorrectionType
	CreatedAt   time.Time
	CreatedBy   string
	BankLines   []BankLine
	BucketLines []BucketLine
}

// Filter narrows List. Zero fields match everything.
type Filter struct {
	Types     []sqlc.TransactionType
	AccountID string
	BucketID  string
	// CycleID limits the list to transactions dated within the cycle.
	CycleID string
	// From and To limit the transaction time to [From, To).
	From, To time.Time
	// Tag matches a tag name, ignoring case.
	Tag string
	// Counterparty matches part of the counterparty, ignoring case.
	Counterparty string
	// Limit is the page size: DefaultLimit if 0, at most MaxLimit.
	Limit int
	// Cursor continues from a previous page's Next.
	Cursor string
}

// Page is one page of List.
type Page struct {
	Items []Transaction
	// Next is the cursor of the next page, or "" on the last page.
	Next string
}

// Options configures a Service.
type Options struct {
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// Service creates and lists transactions.
type Service struct {
	pool   *pgxpool.Pool
	ledger *ledger.Ledger
	now    func() time.Time
}

// NewService returns a Service that records transactions in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now}
}

// Create records an income, expense or transfer.
func (s *Service) Create(ctx context.Context, userID string, n New) (Transaction, error) {
	now := s.now()
	if n.At.IsZero() {
		n.At = now
	}
	if n.At.After(now.Add(ClockSkew)) {
		return Transaction{}, fmt.Errorf("%w: the transaction time is in the future", ErrInvalid)
	}
	var out Transaction
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		t, err := s.record(ctx, tx, userID, n, "")
		if err != nil {
			return err
		}
		out = merge([]sqlc.TransactionHeader{t.Header}, t.BankLines, t.BucketLines, t.Tags, false)
		return nil
	})
	if err != nil {
		return Transaction{}, err
	}
	return out, nil
}

// record checks n and records it inside tx. replaces is the transaction it
// replaces, if any.
func (s *Service) record(ctx context.Context, tx pgx.Tx, userID string, n New, replaces string) (*ledger.Transaction, error) {
	bank, buckets, err := signedLines(n)
	if err != nil {
		return nil, err
	}
	q := sqlc.New(tx)
	if err := checkAccounts(ctx, q, userID, n); err != nil {
		return nil, err
	}
	if err := checkBuckets(ctx, q, userID, n); err != nil {
		return nil, err
	}
	return s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: n.Type, At: n.At, ReplacesID: replaces,
		Counterparty: n.Counterparty, Tags: n.Tags, BankLines: bank, BucketLines: buckets,
	})
}

// signedLines checks n against the rules of its type that don't need the
// database, and returns its lines with their signs.
func signedLines(n New) ([]ledger.BankLine, []ledger.BucketLine, error) {
	if err := positive("amount", n.Amount); err != nil {
		return nil, nil, err
	}
	switch n.Type {
	case sqlc.TransactionTypeINC, sqlc.TransactionTypeEXP:
		if n.ToAccountID != "" {
			return nil, nil, fmt.Errorf("%w: only a transfer has a receiving account", ErrInvalid)
		}
		sign := decimal.NewFromInt(1)
		if n.Type == sqlc.TransactionTypeEXP {
			sign = sign.Neg()
		}
		bank := []ledger.BankLine{{AccountID: n.AccountID, Amount: n.Amount.Mul(sign)}}
		var buckets []ledger.BucketLine
		sum := decimal.Zero
		for _, b := range n.Buckets {
			if err := positive("bucket amount", b.Amount); err != nil {
				return nil, nil, err
			}
			sum = sum.Add(b.Amount)
			buckets = append(buckets, ledger.BucketLine{BucketID: b.BucketID, Amount: b.Amount.Mul(sign)})
		}
		if sum.GreaterThan(n.Amount) {
			return nil, nil, fmt.Errorf("%w: the bucket amounts add up to %s, more than the amount %s",
				ErrInvalid, sum.StringFixed(money.Places), n.Amount.StringFixed(money.Places))
		}
		return bank, buckets, nil
	case sqlc.TransactionTypeTRF:
		if len(n.Buckets) > 0 {
			return nil, nil, fmt.Errorf("%w: a transfer can't have bucket lines", ErrInvalid)
		}
		if n.ToAccountID == "" {
			return nil, nil, fmt.Errorf("%w: a transfer needs a receiving account", ErrInvalid)
		}
		if n.ToAccountID == n.AccountID {
			return nil, nil, fmt.Errorf("%w: a transfer needs two different accounts", ErrInvalid)
		}
		return []ledger.BankLine{
			{AccountID: n.AccountID, Amount: n.Amount.Neg()},
			{AccountID: n.ToAccountID, Amount: n.Amount},
		}, nil, nil
	}
	return nil, nil, fmt.Errorf("%w: transaction type %q can't be entered; use INC, EXP or TRF", ErrInvalid, n.Type)
}

// Get returns a transaction merged with its corrections, with its history.
// The ID of a correction returns the transaction it corrects.
func (s *Service) Get(ctx context.Context, userID, id string) (Transaction, error) {
	q := sqlc.New(s.pool)
	h, err := q.GetTransactionHeader(ctx, sqlc.GetTransactionHeaderParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Transaction{}, fmt.Errorf("%w: transaction %s", ErrNotFound, id)
	}
	if err != nil {
		return Transaction{}, err
	}
	if h.ParentID.Valid {
		id = h.ParentID.String
	}
	list, err := s.load(ctx, q, userID, []string{id}, true)
	if err != nil {
		return Transaction{}, err
	}
	return list[0], nil
}

// List returns a page of the user's transactions, newest first, each merged
// with its corrections.
func (s *Service) List(ctx context.Context, userID string, f Filter) (Page, error) {
	q := sqlc.New(s.pool)
	p := sqlc.ListTransactionsParams{UserID: userID}
	switch {
	case f.Limit == 0:
		f.Limit = DefaultLimit
	case f.Limit < 0 || f.Limit > MaxLimit:
		return Page{}, fmt.Errorf("%w: the limit must be 1 to %d", ErrInvalid, MaxLimit)
	}
	p.RowLimit = int32(f.Limit + 1) //nolint:gosec // at most MaxLimit + 1
	for _, t := range f.Types {
		if !t.Valid() {
			return Page{}, fmt.Errorf("%w: transaction type %q", ErrInvalid, t)
		}
		p.Types = append(p.Types, string(t))
	}
	if f.CycleID != "" {
		c, err := q.GetCycle(ctx, sqlc.GetCycleParams{ID: f.CycleID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return Page{}, fmt.Errorf("%w: cycle %s doesn't exist", ErrInvalid, f.CycleID)
		}
		if err != nil {
			return Page{}, err
		}
		if f.From.IsZero() || f.From.Before(c.StartAt) {
			f.From = c.StartAt
		}
		if f.To.IsZero() || f.To.After(c.EndAt) {
			f.To = c.EndAt
		}
	}
	p.FromAt = timestamptz(f.From)
	p.ToAt = timestamptz(f.To)
	p.AccountID = text(f.AccountID)
	p.BucketID = text(f.BucketID)
	p.Tag = text(strings.TrimSpace(f.Tag))
	if c := strings.TrimSpace(f.Counterparty); c != "" {
		p.Counterparty = text("%" + likeEscaper.Replace(c) + "%")
	}
	if f.Cursor != "" {
		at, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return Page{}, err
		}
		p.BeforeAt, p.BeforeID = timestamptz(at), text(id)
	}

	headers, err := q.ListTransactions(ctx, p)
	if err != nil {
		return Page{}, err
	}
	var page Page
	if len(headers) > f.Limit {
		headers = headers[:f.Limit]
		last := headers[len(headers)-1]
		page.Next = encodeCursor(last.TransactionAt, last.ID)
	}
	idList := make([]string, len(headers))
	for i, h := range headers {
		idList[i] = h.ID
	}
	if page.Items, err = s.load(ctx, q, userID, idList, false); err != nil {
		return Page{}, err
	}
	return page, nil
}

// load returns the original transactions with these IDs, in this order,
// merged with their corrections.
func (s *Service) load(ctx context.Context, q *sqlc.Queries, userID string, originals []string, history bool) ([]Transaction, error) {
	if len(originals) == 0 {
		return []Transaction{}, nil
	}
	headers, err := q.ListTransactionFamilies(ctx, sqlc.ListTransactionFamiliesParams{UserID: userID, Ids: originals})
	if err != nil {
		return nil, err
	}
	all := make([]string, len(headers))
	family := map[string][]sqlc.TransactionHeader{}
	for i, h := range headers {
		all[i] = h.ID
		root := h.ID
		if h.ParentID.Valid {
			root = h.ParentID.String
		}
		family[root] = append(family[root], h)
	}
	bank, err := q.ListBankLinesFor(ctx, all)
	if err != nil {
		return nil, err
	}
	buckets, err := q.ListBucketLinesFor(ctx, all)
	if err != nil {
		return nil, err
	}
	tags, err := q.ListTagsFor(ctx, all)
	if err != nil {
		return nil, err
	}
	replaced, err := q.ListReplacedBy(ctx, originals)
	if err != nil {
		return nil, err
	}

	out := make([]Transaction, 0, len(originals))
	for _, id := range originals {
		fam := family[id]
		if len(fam) == 0 {
			return nil, fmt.Errorf("%w: transaction %s", ErrNotFound, id)
		}
		inFamily := func(txID string) bool {
			return slices.ContainsFunc(fam, func(h sqlc.TransactionHeader) bool { return h.ID == txID })
		}
		// The newest header holds the effective tags.
		newest := fam[len(fam)-1].ID
		var famTags []string
		for _, t := range tags {
			if t.TransactionID == newest {
				famTags = append(famTags, t.Name)
			}
		}
		t := merge(fam,
			filter(bank, func(l sqlc.BankTransaction) bool { return inFamily(l.TransactionID) }),
			filter(buckets, func(l sqlc.BucketTransaction) bool { return inFamily(l.TransactionID) }),
			famTags, history)
		for _, r := range replaced {
			if r.ReplacesID == id {
				t.ReplacedBy = r.ID
			}
		}
		out = append(out, t)
	}
	return out, nil
}

// merge builds a Transaction from a family: the original header first, then
// its corrections, with all their lines. tags are the newest header's, which
// like its counterparty are the effective ones: every correction carries them.
func merge(fam []sqlc.TransactionHeader, bank []sqlc.BankTransaction, buckets []sqlc.BucketTransaction, tags []string, history bool) Transaction {
	orig := fam[0]
	t := Transaction{
		ID: orig.ID, Type: orig.TransactionType, At: orig.TransactionAt, Counterparty: fam[len(fam)-1].Counterparty,
		Tags: tags, CreatedAt: orig.CreatedAt, CreatedBy: orig.CreatedBy.String, Replaces: orig.ReplacesID.String,
	}
	if t.Tags == nil {
		t.Tags = []string{}
	}
	for _, h := range fam[1:] {
		switch h.CorrectionType {
		case sqlc.CorrectionTypeAdjustment:
			t.Corrected = true
		case sqlc.CorrectionTypeReversal:
			t.Reversed = true
		}
	}

	// Sum per account and bucket, in the order they first appear.
	for _, h := range fam {
		for _, l := range bank {
			if l.TransactionID != h.ID {
				continue
			}
			if i := slices.IndexFunc(t.BankLines, func(b BankLine) bool { return b.AccountID == l.AccountID }); i >= 0 {
				t.BankLines[i].Amount = t.BankLines[i].Amount.Add(l.Amount)
			} else {
				t.BankLines = append(t.BankLines, BankLine{AccountID: l.AccountID, Amount: l.Amount})
			}
		}
		for _, l := range buckets {
			if l.TransactionID != h.ID {
				continue
			}
			if i := slices.IndexFunc(t.BucketLines, func(b BucketLine) bool { return b.BucketID == l.BucketID }); i >= 0 {
				t.BucketLines[i].Amount = t.BucketLines[i].Amount.Add(l.Amount)
			} else {
				t.BucketLines = append(t.BucketLines, BucketLine{BucketID: l.BucketID, CycleID: l.CycleID, Amount: l.Amount})
			}
		}
	}
	t.BankLines = slices.DeleteFunc(t.BankLines, func(l BankLine) bool { return l.Amount.IsZero() })
	t.BucketLines = slices.DeleteFunc(t.BucketLines, func(l BucketLine) bool { return l.Amount.IsZero() })
	if t.BankLines == nil {
		t.BankLines = []BankLine{}
	}
	if t.BucketLines == nil {
		t.BucketLines = []BucketLine{}
	}

	if history {
		t.History = make([]Version, len(fam))
		for i, h := range fam {
			v := Version{ID: h.ID, Correction: h.CorrectionType, CreatedAt: h.CreatedAt, CreatedBy: h.CreatedBy.String,
				BankLines: []BankLine{}, BucketLines: []BucketLine{}}
			for _, l := range bank {
				if l.TransactionID == h.ID {
					v.BankLines = append(v.BankLines, BankLine{AccountID: l.AccountID, Amount: l.Amount})
				}
			}
			for _, l := range buckets {
				if l.TransactionID == h.ID {
					v.BucketLines = append(v.BucketLines, BucketLine{BucketID: l.BucketID, CycleID: l.CycleID, Amount: l.Amount})
				}
			}
			t.History[i] = v
		}
	}
	return t
}

// checkAccounts checks that the accounts are the user's live accounts, and
// that a transfer's accounts share a currency.
func checkAccounts(ctx context.Context, q *sqlc.Queries, userID string, n New) error {
	want := []string{n.AccountID}
	if n.ToAccountID != "" {
		want = append(want, n.ToAccountID)
	}
	rows, err := q.GetOwnedAccounts(ctx, sqlc.GetOwnedAccountsParams{Ids: want, UserID: userID})
	if err != nil {
		return err
	}
	currency := map[string]string{}
	for _, r := range rows {
		currency[r.ID] = r.Currency
	}
	for _, id := range want {
		if _, ok := currency[id]; !ok {
			return fmt.Errorf("%w: account %s doesn't exist", ErrInvalid, id)
		}
	}
	if n.ToAccountID != "" && currency[n.AccountID] != currency[n.ToAccountID] {
		return fmt.Errorf("%w: %s is %s, %s is %s", ErrCurrencyMismatch,
			n.AccountID, currency[n.AccountID], n.ToAccountID, currency[n.ToAccountID])
	}
	return nil
}

// checkBuckets checks that every bucket is a live bucket of the user funded
// from the transaction's account.
func checkBuckets(ctx context.Context, q *sqlc.Queries, userID string, n New) error {
	if len(n.Buckets) == 0 {
		return nil
	}
	want := make([]string, len(n.Buckets))
	for i, b := range n.Buckets {
		want[i] = b.BucketID
	}
	rows, err := q.GetOwnedBuckets(ctx, sqlc.GetOwnedBucketsParams{Ids: want, UserID: userID})
	if err != nil {
		return err
	}
	for _, id := range want {
		i := slices.IndexFunc(rows, func(r sqlc.GetOwnedBucketsRow) bool { return r.ID == id })
		if i < 0 {
			return fmt.Errorf("%w: bucket %s doesn't exist", ErrInvalid, id)
		}
		if src := rows[i].SourceAccountID; src != n.AccountID {
			return fmt.Errorf("%w: bucket %s is funded from account %s, not %s", ErrInvalid, id, src, n.AccountID)
		}
	}
	return nil
}

func positive(what string, d decimal.Decimal) error {
	if err := money.Valid(d); err != nil {
		return fmt.Errorf("%w: %s: %w", ErrInvalid, what, err)
	}
	if !d.IsPositive() {
		return fmt.Errorf("%w: the %s must be more than 0", ErrInvalid, what)
	}
	return nil
}

func filter[T any](s []T, keep func(T) bool) []T {
	var out []T
	for _, v := range s {
		if keep(v) {
			out = append(out, v)
		}
	}
	return out
}

// likeEscaper escapes the LIKE wildcards in user input.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func text(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

func timestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: !t.IsZero()}
}

// A cursor is the time (in microseconds) and ID of a page's last row,
// base64-encoded so clients treat it as opaque.
func encodeCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(at.UnixMicro(), 10) + "." + id))
}

func decodeCursor(c string) (time.Time, string, error) {
	invalid := fmt.Errorf("%w: invalid cursor", ErrInvalid)
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return time.Time{}, "", invalid
	}
	micros, id, ok := strings.Cut(string(b), ".")
	us, err := strconv.ParseInt(micros, 10, 64)
	if !ok || err != nil || !ids.Transaction.Valid(id) {
		return time.Time{}, "", invalid
	}
	return time.UnixMicro(us).UTC(), id, nil
}
