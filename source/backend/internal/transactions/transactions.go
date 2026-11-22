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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
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
	// Description is an optional note of what it was (#130).
	Description string
	Tags        []string
	AccountID   string
	// ToAccountID is the receiving account of a transfer.
	ToAccountID string
	Amount      decimal.Decimal
	// Buckets are the parts of an income or expense that go to or come from
	// buckets. Each bucket must be funded from AccountID, and together they
	// can't exceed Amount; the rest isn't tied to a bucket.
	Buckets []BucketAmount
	// TriggersRefill marks an income that refills its account's "On income"
	// buckets (spec §6). Nil leaves it to the user's income rules; an
	// explicit value overrides them.
	TriggersRefill *bool
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
	// Description is the effective description, from the newest correction.
	Description string
	Tags        []string
	CreatedAt   time.Time
	// CreatedBy is the user who entered it, or "" for the system.
	CreatedBy string
	// Corrected is set when it has adjustments, Reversed when it has been
	// reversed.
	Corrected, Reversed bool
	// Replaces is the transaction this one replaced when it was moved to
	// another account; ReplacedBy is the one that replaced it.
	Replaces, ReplacedBy string
	// ScheduleID is the schedule that recorded it, or "" (also once the
	// schedule is deleted).
	ScheduleID string
	// TriggersRefill is set on an income that triggers a refill.
	TriggersRefill bool
	// BankLines and BucketLines are the effective amounts: each account's or
	// bucket's lines summed over the original and its corrections. Lines
	// that sum to zero are left out.
	BankLines   []BankLine
	BucketLines []BucketLine
	// SavingsLines are the effective amounts held (positive) or released per
	// savings holder and source account (#231).
	SavingsLines []SavingsLine
	// BeforeReversal is set on a reversed transaction: its effective lines
	// just before the reversal, which are what it amounted to.
	BeforeReversal *Lines
	// BalancesAfter is each account's balance just after the transaction
	// (#106), counting effective amounts. Get fills it for every account in
	// BankLines; List only with an account filter, for that account. A
	// transaction that comes to 0 in an account has none for it.
	BalancesAfter []AccountBalance
	// History is the original and its corrections, oldest first. Only Get
	// fills it.
	History []Version
}

// Lines are a transaction's amounts per account and bucket.
type Lines struct {
	Bank    []BankLine
	Buckets []BucketLine
	Savings []SavingsLine
}

// SavingsLine is an amount held for a savings holder on a source account.
type SavingsLine struct {
	HolderID  string
	AccountID string
	Amount    decimal.Decimal
}

// BankLine is an amount on an account.
type BankLine struct {
	AccountID string
	Amount    decimal.Decimal
}

// AccountBalance is an account's balance at some point.
type AccountBalance struct {
	AccountID string
	Balance   decimal.Decimal
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
	ID           string
	Correction   sqlc.CorrectionType
	CreatedAt    time.Time
	CreatedBy    string
	BankLines    []BankLine
	BucketLines  []BucketLine
	SavingsLines []SavingsLine
}

// Filter narrows List. Zero fields match everything.
type Filter struct {
	Types []sqlc.TransactionType
	// AccountIDs and BucketIDs match a line on any of them (#126).
	AccountIDs []string
	BucketIDs  []string
	// CycleID limits the list to transactions dated within the cycle.
	CycleID string
	// From and To limit the transaction time to [From, To).
	From, To time.Time
	// Tags match any of these tag names, ignoring case.
	Tags []string
	// Counterparty matches part of the counterparty or the description,
	// ignoring case.
	Counterparty string
	// CounterpartyIs matches the whole effective counterparty, ignoring case
	// and spaces at the ends (#170).
	CounterpartyIs string
	// Reversed, if set, lists only reversed transactions (moved originals
	// too) when true, or only the others when false.
	Reversed *bool
	// Limit is the page size: DefaultLimit if 0, at most MaxLimit.
	Limit int
	// Cursor continues from a previous page's Next.
	Cursor string
	// OldestFirst lists the oldest first instead of the newest (#126).
	OldestFirst bool
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
	// Refills runs the "On income" refills. Nil means incomes never refill.
	Refills *refill.Service
}

// Service creates and lists transactions.
type Service struct {
	pool    *pgxpool.Pool
	ledger  *ledger.Ledger
	now     func() time.Time
	refills *refill.Service
}

// NewService returns a Service that records transactions in l.
func NewService(pool *pgxpool.Pool, l *ledger.Ledger, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, ledger: l, now: opts.Now, refills: opts.Refills}
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
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		t, err := s.record(ctx, tx, userID, n, "")
		if err != nil {
			return err
		}
		out = merge([]sqlc.TransactionHeader{t.Header}, t.BankLines, t.BucketLines, t.SavingsLines, t.Tags, false)
		return nil
	})
	if err != nil {
		return Transaction{}, err
	}
	return out, nil
}

// Check checks n as Create would, without recording it: the rules of its
// type, and that its accounts and buckets are the user's live ones. A zero At
// counts as now.
func Check(ctx context.Context, db sqlc.DBTX, userID string, n New) error {
	bank, buckets, err := signedLines(n)
	if err != nil {
		return err
	}
	at := n.At
	if at.IsZero() {
		at = time.Now()
	}
	if err := ledger.Validate(ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: n.Type, At: at,
		Counterparty: n.Counterparty, Description: n.Description, Tags: n.Tags, BankLines: bank, BucketLines: buckets,
	}); err != nil {
		return err
	}
	q := sqlc.New(db)
	if err := checkAccounts(ctx, q, userID, n); err != nil {
		return err
	}
	return checkBuckets(ctx, q, userID, n)
}

// RecordIn records n inside tx, whose caller holds the user's lock
// (ledger.LockUser), as Create does but at any time n.At, past or future.
// The scheduler records its occurrences with it.
func (s *Service) RecordIn(ctx context.Context, tx pgx.Tx, userID string, n New) (Transaction, error) {
	t, err := s.record(ctx, tx, userID, n, "")
	if err != nil {
		return Transaction{}, err
	}
	return merge([]sqlc.TransactionHeader{t.Header}, t.BankLines, t.BucketLines, t.SavingsLines, t.Tags, false), nil
}

// record checks n and records it inside tx. replaces is the transaction it
// replaces, if any. An income that triggers a refill refills its account's
// "On income" buckets.
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
	triggers := n.TriggersRefill != nil && *n.TriggersRefill
	if n.TriggersRefill == nil && n.Type == sqlc.TransactionTypeINC && s.refills != nil {
		if triggers, err = refill.Triggers(ctx, tx, userID, n.Counterparty, n.Amount); err != nil {
			return nil, err
		}
	}
	t, err := s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: n.Type, At: n.At, ReplacesID: replaces, TriggersRefill: triggers,
		Counterparty: n.Counterparty, Description: n.Description, Tags: n.Tags, BankLines: bank, BucketLines: buckets,
	})
	if err != nil {
		return nil, err
	}
	if triggers && s.refills != nil {
		// Only a flag the user just set must take effect; a moved income
		// carries its flag along and refills only if it can.
		strict := n.TriggersRefill != nil && replaces == ""
		if err := s.refills.OnIncome(ctx, tx, userID, t.Header.ID, n.AccountID, t.Header.TransactionAt, strict); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// signedLines checks n against the rules of its type that don't need the
// database, and returns its lines with their signs.
func signedLines(n New) ([]ledger.BankLine, []ledger.BucketLine, error) {
	if err := positive("amount", n.Amount); err != nil {
		return nil, nil, err
	}
	if n.TriggersRefill != nil && *n.TriggersRefill && n.Type != sqlc.TransactionTypeINC {
		return nil, nil, fmt.Errorf("%w: only an income can trigger a refill", ErrInvalid)
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
	accounts := make([]string, len(list[0].BankLines))
	for i, l := range list[0].BankLines {
		accounts[i] = l.AccountID
	}
	if err := balancesAfter(ctx, q, userID, accounts, list); err != nil {
		return Transaction{}, err
	}
	return list[0], nil
}

// balancesAfter fills the BalancesAfter of list (originals) for accounts.
func balancesAfter(ctx context.Context, q *sqlc.Queries, userID string, accounts []string, list []Transaction) error {
	if len(accounts) == 0 || len(list) == 0 {
		return nil
	}
	ids := make([]string, len(list))
	since := list[0].At
	for i, t := range list {
		ids[i] = t.ID
		if t.At.Before(since) {
			since = t.At
		}
	}
	rows, err := q.BalancesAfter(ctx, sqlc.BalancesAfterParams{Ids: ids, AccountIds: accounts, UserID: userID, Since: since})
	if err != nil {
		return err
	}
	at := make(map[string]int, len(list))
	for i, t := range list {
		at[t.ID] = i
	}
	for _, r := range rows {
		t := &list[at[r.TransactionID]]
		t.BalancesAfter = append(t.BalancesAfter, AccountBalance{AccountID: r.AccountID, Balance: r.Balance})
	}
	return nil
}

// nonEmpty trims the values and drops the empty ones, lowercased if lower;
// nil when none are left, which the query reads as no filter.
func nonEmpty(values []string, lower bool) []string {
	var out []string
	for _, v := range values {
		v = strings.TrimSpace(v)
		if lower {
			v = strings.ToLower(v)
		}
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// List returns a page of the user's transactions, newest first (or oldest
// first), each merged with its corrections.
func (s *Service) List(ctx context.Context, userID string, f Filter) (Page, error) {
	q := sqlc.New(s.pool)
	page, p, err := s.page(ctx, q, userID, f)
	if err != nil {
		return Page{}, err
	}
	// The balance after each (#106) is one account's, so only with one.
	if len(p.AccountIds) == 1 {
		if err := balancesAfter(ctx, q, userID, p.AccountIds, page.Items); err != nil {
			return Page{}, err
		}
	}
	return page, nil
}

// page is one page of List, without the balances after, and the query it
// ran.
func (s *Service) page(ctx context.Context, q *sqlc.Queries, userID string, f Filter) (Page, sqlc.ListTransactionsParams, error) {
	p, err := listParams(ctx, q, userID, f)
	if err != nil {
		return Page{}, p, err
	}
	headers, err := q.ListTransactions(ctx, p)
	if err != nil {
		return Page{}, p, err
	}
	limit := int(p.RowLimit) - 1
	var page Page
	if len(headers) > limit {
		headers = headers[:limit]
		last := headers[len(headers)-1]
		page.Next = encodeCursor(last.TransactionAt, last.ID)
	}
	idList := make([]string, len(headers))
	for i, h := range headers {
		idList[i] = h.ID
	}
	if page.Items, err = s.load(ctx, q, userID, idList, false); err != nil {
		return Page{}, p, err
	}
	return page, p, nil
}

// listParams is the query for one page of f's transactions.
func listParams(ctx context.Context, q *sqlc.Queries, userID string, f Filter) (sqlc.ListTransactionsParams, error) {
	p := sqlc.ListTransactionsParams{UserID: userID, OldestFirst: f.OldestFirst}
	switch {
	case f.Limit == 0:
		f.Limit = DefaultLimit
	case f.Limit < 0 || f.Limit > MaxLimit:
		return p, fmt.Errorf("%w: the limit must be 1 to %d", ErrInvalid, MaxLimit)
	}
	p.RowLimit = int32(f.Limit + 1) //nolint:gosec // at most MaxLimit + 1
	for _, t := range f.Types {
		if !t.Valid() {
			return p, fmt.Errorf("%w: transaction type %q", ErrInvalid, t)
		}
		p.Types = append(p.Types, string(t))
	}
	if f.CycleID != "" {
		c, err := q.GetCycle(ctx, sqlc.GetCycleParams{ID: f.CycleID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return p, fmt.Errorf("%w: cycle %s doesn't exist", ErrInvalid, f.CycleID)
		}
		if err != nil {
			return p, err
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
	p.AccountIds = nonEmpty(f.AccountIDs, false)
	p.BucketIds = nonEmpty(f.BucketIDs, false)
	p.Tags = nonEmpty(f.Tags, true)
	p.Counterparty = likeContains(f.Counterparty)
	if is := strings.TrimSpace(f.CounterpartyIs); is != "" {
		p.CounterpartyIs = pgtype.Text{String: is, Valid: true}
	}
	if f.Reversed != nil {
		p.Reversed = pgtype.Bool{Bool: *f.Reversed, Valid: true}
	}
	if f.Cursor != "" {
		at, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return p, err
		}
		p.BeforeAt, p.BeforeID = timestamptz(at), text(id)
	}
	return p, nil
}

// Summary is how many transactions a filter matches and what they add up
// to (#203).
type Summary struct {
	// Count is the matching transactions, without reversed or moved ones.
	Count int
	// Totals are per currency, in the order the currencies first come
	// (newest first).
	Totals []Totals
}

// Totals are the in, out (positive) and net of one currency's amounts.
type Totals struct {
	Currency     string
	In, Out, Net decimal.Decimal
}

// Summary counts and sums the transactions f matches (its Limit, Cursor
// and OldestFirst aside), as a report's section summary (#191) does: each
// is merged with its corrections; reversed and moved ones don't count; a
// transaction's amount is its bank lines' if it has any, else its bucket
// lines'; one line counts with its sign, and of several (a transfer) only
// the line of the filter's one account, or one bucket, counts. A line is
// in its account's currency, or its bucket's source account's.
func (s *Service) Summary(ctx context.Context, userID string, f Filter) (Summary, error) {
	q := sqlc.New(s.pool)
	accounts, err := q.AccountCurrencies(ctx, userID)
	if err != nil {
		return Summary{}, err
	}
	buckets, err := q.BucketCurrencies(ctx, userID)
	if err != nil {
		return Summary{}, err
	}
	currency := make(map[string]string, len(accounts)+len(buckets))
	for _, a := range accounts {
		currency["a"+a.ID] = a.Currency
	}
	for _, b := range buckets {
		currency["b"+b.ID] = b.Currency
	}
	focusAccount, focusBucket := "", ""
	if len(f.AccountIDs) == 1 {
		focusAccount = f.AccountIDs[0]
	}
	if len(f.BucketIDs) == 1 {
		focusBucket = f.BucketIDs[0]
	}

	var out Summary
	index := map[string]int{}
	add := func(cur string, amount decimal.Decimal) {
		i, ok := index[cur]
		if !ok {
			i = len(out.Totals)
			index[cur] = i
			out.Totals = append(out.Totals, Totals{Currency: cur})
		}
		t := &out.Totals[i]
		if amount.IsPositive() {
			t.In = t.In.Add(amount)
		} else {
			t.Out = t.Out.Sub(amount)
		}
		t.Net = t.In.Sub(t.Out)
	}

	f.Limit, f.Cursor, f.OldestFirst = MaxLimit, "", false
	for {
		page, _, err := s.page(ctx, q, userID, f)
		if err != nil {
			return Summary{}, err
		}
		for _, t := range page.Items {
			if t.Reversed || t.ReplacedBy != "" {
				continue
			}
			out.Count++
			type line struct {
				key    string
				amount decimal.Decimal
			}
			var lines []line
			focus := ""
			if len(t.BankLines) > 0 {
				for _, l := range t.BankLines {
					lines = append(lines, line{"a" + l.AccountID, l.Amount})
				}
				if focusAccount != "" {
					focus = "a" + focusAccount
				}
			} else {
				for _, l := range t.BucketLines {
					lines = append(lines, line{"b" + l.BucketID, l.Amount})
				}
				if focusBucket != "" {
					focus = "b" + focusBucket
				}
			}
			if len(lines) == 0 {
				continue
			}
			counted := lines[0]
			if len(lines) > 1 {
				found := false
				for _, l := range lines {
					if l.key == focus {
						counted, found = l, true
						break
					}
				}
				if !found {
					continue // A transfer seen from neither side adds nothing.
				}
			}
			// As a row shows it: in the currency of its first line's account.
			add(currency[lines[0].key], counted.amount)
		}
		if page.Next == "" {
			return out, nil
		}
		f.Cursor = page.Next
	}
}

// The page sizes of Tags and Counterparties: the default if 0, at most the
// maximum.
const (
	DefaultTagLimit          = 50
	MaxTagLimit              = 100
	DefaultCounterpartyLimit = 10
	MaxCounterpartyLimit     = 50
)

// Tag is one of the user's tags, for autocompletion.
type Tag struct {
	Name string
	// LastUsed is the time of the newest transaction with the tag, or zero
	// if no transaction has it.
	LastUsed time.Time
}

// Counterparty is a counterparty the user has entered before, with what its
// newest income or expense used: the values to suggest the next time.
type Counterparty struct {
	Counterparty string
	Type         sqlc.TransactionType
	At           time.Time
	AccountID    string
	Tags         []string
	BucketIDs    []string
}

// Tags returns the user's tags whose name contains q (ignoring case), most
// recently used first, then unused ones by name.
func (s *Service) Tags(ctx context.Context, userID, q string, limit int) ([]Tag, error) {
	limit, err := checkLimit(limit, DefaultTagLimit, MaxTagLimit)
	if err != nil {
		return nil, err
	}
	rows, err := sqlc.New(s.pool).ListTagSuggestions(ctx, sqlc.ListTagSuggestionsParams{
		UserID: userID, Q: likeContains(q), RowLimit: int32(limit), //nolint:gosec // at most MaxTagLimit
	})
	if err != nil {
		return nil, err
	}
	out := make([]Tag, len(rows))
	for i, r := range rows {
		out[i] = Tag{Name: r.Name}
		if r.Used {
			out[i].LastUsed = r.LastUsedAt
		}
	}
	return out, nil
}

// Counterparties returns the counterparties of the user's incomes and
// expenses (only typ's, if given) that contain q, ignoring case. Each is
// listed once, newest first, with the effective values of its newest
// transaction that isn't reversed.
func (s *Service) Counterparties(ctx context.Context, userID, q string, typ sqlc.TransactionType, limit int) ([]Counterparty, error) {
	limit, err := checkLimit(limit, DefaultCounterpartyLimit, MaxCounterpartyLimit)
	if err != nil {
		return nil, err
	}
	types := []string{string(sqlc.TransactionTypeINC), string(sqlc.TransactionTypeEXP)}
	switch typ {
	case "":
	case sqlc.TransactionTypeINC, sqlc.TransactionTypeEXP:
		types = []string{string(typ)}
	default:
		return nil, fmt.Errorf("%w: only incomes and expenses have counterparties to suggest", ErrInvalid)
	}
	db := sqlc.New(s.pool)
	ids, err := db.ListCounterpartyOriginals(ctx, sqlc.ListCounterpartyOriginalsParams{
		UserID: userID, Types: types, Q: likeContains(q), RowLimit: int32(limit), //nolint:gosec // at most MaxCounterpartyLimit
	})
	if err != nil {
		return nil, err
	}
	list, err := s.load(ctx, db, userID, ids, false)
	if err != nil {
		return nil, err
	}
	out := make([]Counterparty, len(list))
	for i, t := range list {
		c := Counterparty{Counterparty: t.Counterparty, Type: t.Type, At: t.At, Tags: t.Tags, BucketIDs: []string{}}
		if len(t.BankLines) > 0 {
			c.AccountID = t.BankLines[0].AccountID
		}
		for _, l := range t.BucketLines {
			if !slices.Contains(c.BucketIDs, l.BucketID) {
				c.BucketIDs = append(c.BucketIDs, l.BucketID)
			}
		}
		out[i] = c
	}
	return out, nil
}

// checkLimit returns the page size: def if 0, an error outside 1..maximum.
func checkLimit(limit, def, maximum int) (int, error) {
	switch {
	case limit == 0:
		return def, nil
	case limit < 0 || limit > maximum:
		return 0, fmt.Errorf("%w: the limit must be 1 to %d", ErrInvalid, maximum)
	}
	return limit, nil
}

// likeContains is a LIKE pattern matching text that contains s, or null for
// an empty s.
func likeContains(s string) pgtype.Text {
	if s = strings.TrimSpace(s); s == "" {
		return pgtype.Text{}
	}
	return text("%" + likeEscaper.Replace(s) + "%")
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
	savings, err := q.ListSavingsLinesFor(ctx, all)
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
	scheduled, err := q.ListSchedulesFor(ctx, originals)
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
			filter(savings, func(l sqlc.SavingsTransaction) bool { return inFamily(l.TransactionID) }),
			famTags, history)
		for _, r := range replaced {
			if r.ReplacesID == id {
				t.ReplacedBy = r.ID
			}
		}
		for _, r := range scheduled {
			if r.TransactionID == id {
				t.ScheduleID = r.ScheduleID
			}
		}
		out = append(out, t)
	}
	return out, nil
}

// sumLines sums the lines of these headers per account and bucket, in the
// order they first appear, leaving out sums of 0.
func sumLines(fam []sqlc.TransactionHeader, bank []sqlc.BankTransaction, buckets []sqlc.BucketTransaction) ([]BankLine, []BucketLine) {
	bankOut, bucketOut := []BankLine{}, []BucketLine{}
	for _, h := range fam {
		for _, l := range bank {
			if l.TransactionID != h.ID {
				continue
			}
			if i := slices.IndexFunc(bankOut, func(b BankLine) bool { return b.AccountID == l.AccountID }); i >= 0 {
				bankOut[i].Amount = bankOut[i].Amount.Add(l.Amount)
			} else {
				bankOut = append(bankOut, BankLine{AccountID: l.AccountID, Amount: l.Amount})
			}
		}
		for _, l := range buckets {
			if l.TransactionID != h.ID {
				continue
			}
			if i := slices.IndexFunc(bucketOut, func(b BucketLine) bool { return b.BucketID == l.BucketID }); i >= 0 {
				bucketOut[i].Amount = bucketOut[i].Amount.Add(l.Amount)
			} else {
				bucketOut = append(bucketOut, BucketLine{BucketID: l.BucketID, CycleID: l.CycleID, Amount: l.Amount})
			}
		}
	}
	bankOut = slices.DeleteFunc(bankOut, func(l BankLine) bool { return l.Amount.IsZero() })
	bucketOut = slices.DeleteFunc(bucketOut, func(l BucketLine) bool { return l.Amount.IsZero() })
	return bankOut, bucketOut
}

// sumSavings sums the savings lines of these headers per holder and account,
// in the order they first appear, leaving out sums of 0.
func sumSavings(fam []sqlc.TransactionHeader, savings []sqlc.SavingsTransaction) []SavingsLine {
	out := []SavingsLine{}
	for _, h := range fam {
		for _, l := range savings {
			if l.TransactionID != h.ID {
				continue
			}
			if i := slices.IndexFunc(out, func(s SavingsLine) bool {
				return s.HolderID == l.HolderID && s.AccountID == l.AccountID
			}); i >= 0 {
				out[i].Amount = out[i].Amount.Add(l.Amount)
			} else {
				out = append(out, SavingsLine{HolderID: l.HolderID, AccountID: l.AccountID, Amount: l.Amount})
			}
		}
	}
	return slices.DeleteFunc(out, func(l SavingsLine) bool { return l.Amount.IsZero() })
}

// merge builds a Transaction from a family: the original header first, then
// its corrections, with all their lines. tags are the newest header's, which
// like its counterparty and description are the effective ones: every
// correction carries them.
func merge(fam []sqlc.TransactionHeader, bank []sqlc.BankTransaction, buckets []sqlc.BucketTransaction,
	savings []sqlc.SavingsTransaction, tags []string, history bool) Transaction {
	orig := fam[0]
	t := Transaction{
		ID: orig.ID, Type: orig.TransactionType, At: orig.TransactionAt, Counterparty: fam[len(fam)-1].Counterparty,
		Description: fam[len(fam)-1].Description, TriggersRefill: fam[len(fam)-1].TriggersRefill,
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

	t.BankLines, t.BucketLines = sumLines(fam, bank, buckets)
	t.SavingsLines = sumSavings(fam, savings)
	if i := slices.IndexFunc(fam, func(h sqlc.TransactionHeader) bool {
		return h.CorrectionType == sqlc.CorrectionTypeReversal
	}); i > 0 {
		var before Lines
		before.Bank, before.Buckets = sumLines(fam[:i], bank, buckets)
		before.Savings = sumSavings(fam[:i], savings)
		t.BeforeReversal = &before
	}

	if history {
		t.History = make([]Version, len(fam))
		for i, h := range fam {
			v := Version{ID: h.ID, Correction: h.CorrectionType, CreatedAt: h.CreatedAt, CreatedBy: h.CreatedBy.String,
				BankLines: []BankLine{}, BucketLines: []BucketLine{}, SavingsLines: []SavingsLine{}}
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
			for _, l := range savings {
				if l.TransactionID == h.ID {
					v.SavingsLines = append(v.SavingsLines, SavingsLine{HolderID: l.HolderID, AccountID: l.AccountID, Amount: l.Amount})
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
