// Package ledger records transactions (spec §5): a header plus one line per
// affected bank account or bucket, written atomically.
//
// The ledger is append-only. Rows are never updated or deleted (a database
// trigger enforces it); an edit is a new correction transaction pointing at
// its parent. The ledger checks what holds for every transaction: the number
// of lines per type (§5.4), ownership, amounts (internal/money) and that
// bucket lines fall in the owner's active cycle (§5.5). Rules that belong to
// one kind of transaction, like signs or which buckets an income may fund,
// are up to its caller.
//
// Savings lines (#231) are a third kind of line: money reserved in a source
// account for a savings holder (a target or the distributor). They get the
// cycle their time falls in, if any, but don't need an active one.
package ledger

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Errors returned by Record. They wrap a message that says what is wrong.
var (
	// ErrInvalid means the entry breaks a ledger rule.
	ErrInvalid = errors.New("invalid transaction")
	// ErrNotFound means an account, bucket or parent transaction doesn't
	// exist, isn't the user's, or is deleted.
	ErrNotFound = errors.New("not found")
	// ErrNoActiveCycle means the entry has bucket lines but the user has no
	// active cycle.
	ErrNoActiveCycle = errors.New("no active cycle")
	// ErrOutsideCycle means the entry has bucket lines but its time is
	// outside the active cycle.
	ErrOutsideCycle = errors.New("transaction time is outside the active cycle")
	// ErrUnsupported means the transaction type isn't available yet.
	ErrUnsupported = errors.New("transaction type not supported")
)

// Limits on the free-text fields.
const (
	MaxCounterparty = 200
	MaxDescription  = 500
	MaxTags         = 20
	MaxTagLength    = 50
)

// Entry is a transaction to record.
type Entry struct {
	UserID string
	// CreatedBy is the user who made the transaction, or "" for the system.
	CreatedBy string
	Type      sqlc.TransactionType
	// Correction is empty or none for an original transaction. Adjustments
	// and reversals need ParentID.
	Correction sqlc.CorrectionType
	ParentID   string
	// ReplacesID is set on an original that replaces a reversed transaction
	// (moved to another account).
	ReplacesID string
	// TriggersRefill marks an income that refills its account's "On income"
	// buckets (spec §6). Only INC may set it; corrections carry it along.
	TriggersRefill bool
	// At is when the transaction happened. It is stored in UTC, to the
	// microsecond.
	At           time.Time
	Counterparty string
	// Description is an optional note of what it was, of up to
	// MaxDescription characters and possibly several lines.
	Description string
	Tags        []string
	BankLines   []BankLine
	BucketLines []BucketLine
	// SavingsLines reserve money for savings (positive) or release it.
	SavingsLines []SavingsLine
}

// BankLine is an amount on a bank account, in the account's currency.
type BankLine struct {
	AccountID string
	Amount    decimal.Decimal
	// Original is set for a foreign-currency transaction.
	Original *Foreign
}

// Foreign is the original amount of a foreign-currency transaction. The
// exchange rate is derived from it and the line's amount.
type Foreign struct {
	Amount   decimal.Decimal
	Currency string
}

// BucketLine is an amount on a bucket.
type BucketLine struct {
	BucketID string
	Amount   decimal.Decimal
}

// SavingsLine is an amount held for a savings holder, reserved on a source
// account.
type SavingsLine struct {
	HolderID  string
	AccountID string
	Amount    decimal.Decimal
}

// Transaction is a recorded transaction.
type Transaction struct {
	Header       sqlc.TransactionHeader
	BankLines    []sqlc.BankTransaction
	BucketLines  []sqlc.BucketTransaction
	SavingsLines []sqlc.SavingsTransaction
	// Tags are sorted case-insensitively.
	Tags []string
}

// Options configures a Ledger.
type Options struct {
	// AfterRecord runs after a transaction's rows are written, in the same
	// database transaction. An error rolls everything back. The Money
	// Allocation Routine (#17) hooks in here.
	AfterRecord func(ctx context.Context, tx pgx.Tx, t *Transaction) error
}

// Ledger records transactions.
type Ledger struct {
	opts Options
}

// New returns a Ledger.
func New(opts Options) *Ledger { return &Ledger{opts: opts} }

// shape is how many lines an original transaction of a type has (§5.4).
type shape struct {
	bank int
	// bankOptional allows no bank lines instead of bank.
	bankOptional           bool
	minBucket, maxBucket   int // maxBucket < 0: no limit
	minSavings, maxSavings int // maxSavings < 0: no limit
}

var shapes = map[sqlc.TransactionType]shape{
	sqlc.TransactionTypeOPB: {bank: 1},
	sqlc.TransactionTypeBLA: {bank: 1},
	sqlc.TransactionTypeINC: {bank: 1, maxBucket: -1},
	sqlc.TransactionTypeEXP: {bank: 1, maxBucket: -1},
	// A transfer that does Done on held funds (#231) has a savings line.
	sqlc.TransactionTypeTRF: {bank: 2, maxSavings: 1},
	sqlc.TransactionTypeOPF: {minBucket: 1, maxBucket: 1},
	sqlc.TransactionTypeREF: {minBucket: 1, maxBucket: 1},
	sqlc.TransactionTypeBUA: {minBucket: 1, maxBucket: 1},
	sqlc.TransactionTypeBAT: {minBucket: 2, maxBucket: 2},
	sqlc.TransactionTypeOVF: {minBucket: 1, maxBucket: 1, maxSavings: 2},
	// A savings budget amount (#234) cut at a target's goal holds the rest
	// for the distributor.
	sqlc.TransactionTypeSVR: {minSavings: 1, maxSavings: 2},
	sqlc.TransactionTypeSVC: {minSavings: 1, maxSavings: 1},
	// Savings to a bucket: straight from unallocated (bucket line only), or
	// held funds (a savings line), moved from another account (2 bank lines).
	sqlc.TransactionTypeSVB: {bank: 2, bankOptional: true, minBucket: 1, maxBucket: 1, maxSavings: 1},
	// A savings distribution (#232) on one source account: a line off the
	// distributor and one per target it gave to, or a bucket line for a
	// bucket target funded from that account.
	sqlc.TransactionTypeSVD: {minSavings: 1, maxSavings: -1, maxBucket: -1},
}

// Create records e in a new database transaction.
func (l *Ledger) Create(ctx context.Context, pool *pgxpool.Pool, e Entry) (*Transaction, error) {
	var t *Transaction
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		t, err = l.Record(ctx, tx, e)
		return err
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

// Record records e inside tx, so callers can combine it with other writes
// (an account and its opening balance, the transactions of a cycle routine).
// On error, roll tx back: some rows may have been written.
func (l *Ledger) Record(ctx context.Context, tx pgx.Tx, e Entry) (*Transaction, error) {
	e, err := normalize(e)
	if err != nil {
		return nil, err
	}
	q := sqlc.New(tx)
	if err := LockUser(ctx, tx, e.UserID); err != nil {
		return nil, err
	}

	if e.Correction != sqlc.CorrectionTypeNone {
		if err := checkParent(ctx, q, e); err != nil {
			return nil, err
		}
	}
	if err := checkOwned(ctx, q, e); err != nil {
		return nil, err
	}
	var cycleID string
	if len(e.BucketLines) > 0 {
		if cycleID, err = activeCycle(ctx, q, e); err != nil {
			return nil, err
		}
	}
	var savingsCycle pgtype.Text
	if len(e.SavingsLines) > 0 {
		if cycleID != "" {
			savingsCycle = pgtype.Text{String: cycleID, Valid: true}
		} else if id, err := q.CycleAt(ctx, sqlc.CycleAtParams{UserID: e.UserID, At: e.At}); err == nil {
			savingsCycle = pgtype.Text{String: id, Valid: true}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	createdBy := pgtype.Text{String: e.CreatedBy, Valid: e.CreatedBy != ""}
	t := &Transaction{}
	_, err = ids.Insert(ctx, ids.Transaction, func() string { return ids.NewTransaction(e.At) },
		func(ctx context.Context, id string) (bool, error) {
			var err error
			t.Header, err = q.CreateTransactionHeader(ctx, sqlc.CreateTransactionHeaderParams{
				ID:              id,
				UserID:          e.UserID,
				ParentID:        pgtype.Text{String: e.ParentID, Valid: e.ParentID != ""},
				CorrectionType:  e.Correction,
				TransactionType: e.Type,
				TransactionAt:   e.At,
				Counterparty:    e.Counterparty,
				CreatedBy:       createdBy,
				ReplacesID:      pgtype.Text{String: e.ReplacesID, Valid: e.ReplacesID != ""},
				TriggersRefill:  e.TriggersRefill,
				Description:     e.Description,
			})
			return ids.Inserted(err)
		})
	if err != nil {
		return nil, fmt.Errorf("create transaction header: %w", err)
	}

	for _, line := range e.BankLines {
		params := sqlc.CreateBankLineParams{
			TransactionID: t.Header.ID,
			AccountID:     line.AccountID,
			Amount:        line.Amount,
			CreatedBy:     createdBy,
		}
		if f := line.Original; f != nil {
			params.OriginalAmount = decimal.NewNullDecimal(f.Amount)
			params.OriginalCurrency = pgtype.Text{String: f.Currency, Valid: true}
			params.ExchangeRate = decimal.NewNullDecimal(money.Rate(line.Amount, f.Amount))
		}
		var row sqlc.BankTransaction
		_, err := ids.Insert(ctx, ids.BankLine, func() string { return ids.NewBankLine(line.AccountID) },
			func(ctx context.Context, id string) (bool, error) {
				params.ID = id
				var err error
				row, err = q.CreateBankLine(ctx, params)
				return ids.Inserted(err)
			})
		if err != nil {
			return nil, fmt.Errorf("create bank line: %w", err)
		}
		t.BankLines = append(t.BankLines, row)
	}

	for _, line := range e.BucketLines {
		var row sqlc.BucketTransaction
		_, err := ids.Insert(ctx, ids.BucketLine, func() string { return ids.NewBucketLine(line.BucketID) },
			func(ctx context.Context, id string) (bool, error) {
				var err error
				row, err = q.CreateBucketLine(ctx, sqlc.CreateBucketLineParams{
					ID:            id,
					TransactionID: t.Header.ID,
					BucketID:      line.BucketID,
					CycleID:       cycleID,
					Amount:        line.Amount,
					CreatedBy:     createdBy,
				})
				return ids.Inserted(err)
			})
		if err != nil {
			return nil, fmt.Errorf("create bucket line: %w", err)
		}
		t.BucketLines = append(t.BucketLines, row)
	}

	for _, line := range e.SavingsLines {
		var row sqlc.SavingsTransaction
		_, err := ids.Insert(ctx, ids.SavingsLine, func() string { return ids.NewSavingsLine(line.HolderID) },
			func(ctx context.Context, id string) (bool, error) {
				var err error
				row, err = q.CreateSavingsLine(ctx, sqlc.CreateSavingsLineParams{
					ID:            id,
					TransactionID: t.Header.ID,
					HolderID:      line.HolderID,
					AccountID:     line.AccountID,
					CycleID:       savingsCycle,
					Amount:        line.Amount,
					CreatedBy:     createdBy,
				})
				return ids.Inserted(err)
			})
		if err != nil {
			return nil, fmt.Errorf("create savings line: %w", err)
		}
		t.SavingsLines = append(t.SavingsLines, row)
	}

	for _, name := range e.Tags {
		tag, err := q.UpsertTag(ctx, sqlc.UpsertTagParams{UserID: e.UserID, Name: name})
		if err != nil {
			return nil, fmt.Errorf("create tag: %w", err)
		}
		if err := q.AddTransactionTag(ctx, sqlc.AddTransactionTagParams{
			TransactionID: t.Header.ID, TagID: tag.ID, UserID: e.UserID,
		}); err != nil {
			return nil, fmt.Errorf("tag transaction: %w", err)
		}
		t.Tags = append(t.Tags, tag.Name) // the stored spelling
	}
	sortTags(t.Tags)

	if l.opts.AfterRecord != nil {
		if err := l.opts.AfterRecord(ctx, tx, t); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// LockUser takes the user's write lock, held until tx ends. Every database
// transaction that changes a user's money (accounts, buckets, cycles, the
// ledger and CAF) takes it first, before any row lock, so the user's writes
// run one at a time and can't deadlock on each other's row locks: the ledger
// share-locks the rows it records on, and the allocation routine then updates
// buckets of the same accounts. Taking it again in the same transaction is a
// no-op.
func LockUser(ctx context.Context, tx pgx.Tx, userID string) error {
	if err := sqlc.New(tx).LockUser(ctx, userID); err != nil {
		return fmt.Errorf("lock user %s: %w", userID, err)
	}
	return nil
}

// Get returns the user's transaction with this ID, or ErrNotFound.
func Get(ctx context.Context, db sqlc.DBTX, userID, id string) (*Transaction, error) {
	q := sqlc.New(db)
	header, err := q.GetTransactionHeader(ctx, sqlc.GetTransactionHeaderParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: transaction %s", ErrNotFound, id)
	}
	if err != nil {
		return nil, err
	}
	t := &Transaction{Header: header}
	if t.BankLines, err = q.ListBankLines(ctx, id); err != nil {
		return nil, err
	}
	if t.BucketLines, err = q.ListBucketLines(ctx, id); err != nil {
		return nil, err
	}
	if t.SavingsLines, err = q.ListSavingsLines(ctx, id); err != nil {
		return nil, err
	}
	if t.Tags, err = q.ListTransactionTags(ctx, id); err != nil {
		return nil, err
	}
	return t, nil
}

// Validate checks e as Record would before touching the database: types,
// signs, tags, counterparty and lines given twice.
func Validate(e Entry) error {
	_, err := normalize(e)
	return err
}

// normalize checks everything that doesn't need the database and returns e
// in its stored form.
func normalize(e Entry) (Entry, error) {
	invalid := func(format string, args ...any) (Entry, error) {
		return Entry{}, fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
	}

	if !ids.User.Valid(e.UserID) {
		return invalid("user ID %q", e.UserID)
	}
	if e.CreatedBy != "" && !ids.User.Valid(e.CreatedBy) {
		return invalid("created by %q", e.CreatedBy)
	}
	if e.At.IsZero() {
		return invalid("no transaction time")
	}
	e.At = e.At.UTC().Truncate(time.Microsecond)

	if e.Type == sqlc.TransactionTypeINP {
		return Entry{}, fmt.Errorf("%w: %s", ErrUnsupported, e.Type)
	}
	s, ok := shapes[e.Type]
	if !ok {
		return invalid("unknown transaction type %q", e.Type)
	}

	if e.TriggersRefill && e.Type != sqlc.TransactionTypeINC {
		return invalid("only an income triggers a refill")
	}

	if e.Correction == "" {
		e.Correction = sqlc.CorrectionTypeNone
	}
	switch e.Correction {
	case sqlc.CorrectionTypeNone:
		if e.ParentID != "" {
			return invalid("only corrections have a parent transaction")
		}
		if e.ReplacesID != "" && !ids.Transaction.Valid(e.ReplacesID) {
			return invalid("replaces %q", e.ReplacesID)
		}
		if n := len(e.BankLines); n != s.bank && (n != 0 || !s.bankOptional) {
			return invalid("%s needs %d bank line(s), got %d", e.Type, s.bank, n)
		}
		if n := len(e.BucketLines); n < s.minBucket || (s.maxBucket >= 0 && n > s.maxBucket) {
			if s.minBucket == s.maxBucket {
				return invalid("%s needs %d bucket line(s), got %d", e.Type, s.minBucket, n)
			}
			return invalid("%s can't have bucket lines", e.Type)
		}
		if n := len(e.SavingsLines); n < s.minSavings || (s.maxSavings >= 0 && n > s.maxSavings) {
			if s.maxSavings == 0 {
				return invalid("%s can't have savings lines", e.Type)
			}
			return invalid("%s needs %d to %d savings line(s), got %d", e.Type, s.minSavings, s.maxSavings, n)
		}
	case sqlc.CorrectionTypeAdjustment, sqlc.CorrectionTypeReversal:
		if !ids.Transaction.Valid(e.ParentID) {
			return invalid("a %s needs a parent transaction", e.Correction)
		}
		if e.ReplacesID != "" {
			return invalid("only originals replace a transaction")
		}
		// A correction changes some of its parent's lines, so it can have
		// fewer lines than the type needs, but none of a kind the type lacks.
		// An adjustment without lines changes only the counterparty or tags.
		if e.Correction == sqlc.CorrectionTypeReversal && len(e.BankLines)+len(e.BucketLines)+len(e.SavingsLines) == 0 {
			return invalid("a reversal needs at least one line")
		}
		if len(e.BankLines) > s.bank {
			return invalid("%s has at most %d bank line(s)", e.Type, s.bank)
		}
		if s.maxBucket >= 0 && len(e.BucketLines) > s.maxBucket {
			return invalid("%s has at most %d bucket line(s)", e.Type, s.maxBucket)
		}
		if s.maxSavings >= 0 && len(e.SavingsLines) > s.maxSavings {
			return invalid("%s has at most %d savings line(s)", e.Type, s.maxSavings)
		}
	default:
		return invalid("unknown correction type %q", e.Correction)
	}

	seen := map[string]bool{}
	for _, line := range e.BankLines {
		if !ids.Account.Valid(line.AccountID) {
			return invalid("account ID %q", line.AccountID)
		}
		if seen[line.AccountID] {
			return invalid("account %s appears twice", line.AccountID)
		}
		seen[line.AccountID] = true
		if err := checkAmount(line.Amount); err != nil {
			return Entry{}, err
		}
		if f := line.Original; f != nil {
			if err := checkAmount(f.Amount); err != nil {
				return Entry{}, fmt.Errorf("original %w", err)
			}
			if err := money.ValidCurrency(f.Currency); err != nil {
				return Entry{}, fmt.Errorf("%w: %w", ErrInvalid, err)
			}
		}
	}
	for _, line := range e.BucketLines {
		if !ids.Bucket.Valid(line.BucketID) {
			return invalid("bucket ID %q", line.BucketID)
		}
		if seen[line.BucketID] {
			return invalid("bucket %s appears twice", line.BucketID)
		}
		seen[line.BucketID] = true
		if err := checkAmount(line.Amount); err != nil {
			return Entry{}, err
		}
	}
	for _, line := range e.SavingsLines {
		if !ids.SavingsHolder.Valid(line.HolderID) {
			return invalid("savings holder ID %q", line.HolderID)
		}
		if !ids.Account.Valid(line.AccountID) {
			return invalid("account ID %q", line.AccountID)
		}
		key := "savings " + line.HolderID + " " + line.AccountID
		if seen[key] {
			return invalid("savings holder %s appears twice on account %s", line.HolderID, line.AccountID)
		}
		seen[key] = true
		if err := checkAmount(line.Amount); err != nil {
			return Entry{}, err
		}
	}

	e.Counterparty = strings.TrimSpace(e.Counterparty)
	if utf8.RuneCountInString(e.Counterparty) > MaxCounterparty {
		return invalid("counterparty is longer than %d characters", MaxCounterparty)
	}
	e.Description = CleanDescription(e.Description)
	if utf8.RuneCountInString(e.Description) > MaxDescription {
		return invalid("the description is longer than %d characters", MaxDescription)
	}

	var tags []string
	for _, tag := range e.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if utf8.RuneCountInString(tag) > MaxTagLength {
			return invalid("tag %q is longer than %d characters", tag, MaxTagLength)
		}
		if !slices.ContainsFunc(tags, func(t string) bool { return strings.EqualFold(t, tag) }) {
			tags = append(tags, tag)
		}
	}
	if len(tags) > MaxTags {
		return invalid("more than %d tags", MaxTags)
	}
	e.Tags = tags
	return e, nil
}

func checkAmount(d decimal.Decimal) error {
	if d.IsZero() {
		return fmt.Errorf("%w: amount is zero", ErrInvalid)
	}
	if err := money.Valid(d); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	return nil
}

func checkParent(ctx context.Context, q *sqlc.Queries, e Entry) error {
	parent, err := q.GetTransactionHeader(ctx, sqlc.GetTransactionHeaderParams{ID: e.ParentID, UserID: e.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: transaction %s", ErrNotFound, e.ParentID)
	}
	if err != nil {
		return err
	}
	if parent.CorrectionType != sqlc.CorrectionTypeNone {
		return fmt.Errorf("%w: correct the original transaction, not a correction", ErrInvalid)
	}
	if parent.TransactionType != e.Type {
		return fmt.Errorf("%w: a correction of a %s must be a %s", ErrInvalid, parent.TransactionType, parent.TransactionType)
	}
	return nil
}

// checkOwned checks that the accounts, buckets and savings holders exist, belong to the user
// and aren't deleted.
func checkOwned(ctx context.Context, q *sqlc.Queries, e Entry) error {
	var want []string
	for _, line := range e.BankLines {
		want = append(want, line.AccountID)
	}
	for _, line := range e.SavingsLines {
		if !slices.Contains(want, line.AccountID) {
			want = append(want, line.AccountID)
		}
	}
	if len(want) > 0 {
		rows, err := q.GetOwnedAccounts(ctx, sqlc.GetOwnedAccountsParams{Ids: want, UserID: e.UserID})
		if err != nil {
			return err
		}
		if missing := firstMissing(want, rows, func(r sqlc.GetOwnedAccountsRow) string { return r.ID }); missing != "" {
			return fmt.Errorf("%w: account %s", ErrNotFound, missing)
		}
	}
	if len(e.BucketLines) > 0 {
		want := make([]string, len(e.BucketLines))
		for i, line := range e.BucketLines {
			want[i] = line.BucketID
		}
		rows, err := q.GetOwnedBuckets(ctx, sqlc.GetOwnedBucketsParams{Ids: want, UserID: e.UserID})
		if err != nil {
			return err
		}
		if missing := firstMissing(want, rows, func(r sqlc.GetOwnedBucketsRow) string { return r.ID }); missing != "" {
			return fmt.Errorf("%w: bucket %s", ErrNotFound, missing)
		}
	}
	if len(e.SavingsLines) > 0 {
		var holders []string
		for _, line := range e.SavingsLines {
			if !slices.Contains(holders, line.HolderID) {
				holders = append(holders, line.HolderID)
			}
		}
		rows, err := q.GetOwnedSavingsHolders(ctx, sqlc.GetOwnedSavingsHoldersParams{Ids: holders, UserID: e.UserID})
		if err != nil {
			return err
		}
		if missing := firstMissing(holders, rows, func(id string) string { return id }); missing != "" {
			return fmt.Errorf("%w: savings target %s", ErrNotFound, missing)
		}
	}
	return nil
}

func firstMissing[R any](want []string, rows []R, id func(R) string) string {
	for _, w := range want {
		if !slices.ContainsFunc(rows, func(r R) bool { return id(r) == w }) {
			return w
		}
	}
	return ""
}

// activeCycle returns the user's active cycle, locked against being ended,
// after checking that the entry's time falls inside it.
func activeCycle(ctx context.Context, q *sqlc.Queries, e Entry) (string, error) {
	c, err := q.GetActiveCycle(ctx, e.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNoActiveCycle
	}
	if err != nil {
		return "", err
	}
	if e.At.Before(c.StartAt) || !e.At.Before(c.EndAt) {
		return "", fmt.Errorf("%w (%s up to %s)", ErrOutsideCycle,
			c.StartAt.UTC().Format(time.RFC3339), c.EndAt.UTC().Format(time.RFC3339))
	}
	return c.ID, nil
}

// sortTags sorts like ListTransactionTags: case-insensitively, bytewise.
func sortTags(tags []string) {
	slices.SortFunc(tags, func(a, b string) int {
		return strings.Compare(strings.ToLower(a), strings.ToLower(b))
	})
}

// CleanDescription is a description as it's stored: Windows line breaks
// made plain, and trimmed at both ends.
func CleanDescription(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
}
