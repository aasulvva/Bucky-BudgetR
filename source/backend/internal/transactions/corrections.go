package transactions

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

var (
	// ErrNotCorrectable means the transaction's type can't be corrected or
	// reversed: the routines and Bucket setup own REF, OVF, OPF, BUA and BAT.
	ErrNotCorrectable = errors.New("this type of transaction can't be corrected")
	// ErrAlreadyReversed means the transaction has been reversed.
	ErrAlreadyReversed = errors.New("the transaction has been reversed")
	// ErrNoChange means the correction changes nothing.
	ErrNoChange = errors.New("nothing to change")
	// ErrBucketLinesLocked means the change needs bucket lines, but the
	// transaction is outside the active cycle (§5.5).
	ErrBucketLinesLocked = errors.New("the transaction's bucket lines are locked")
	// ErrSavingsTransfer means the change would alter the amount or accounts
	// of a transfer that did Done on held savings (#231). Reverse it, which
	// puts the money back on hold, and do Done again instead.
	ErrSavingsTransfer = errors.New("a savings transfer's amount and accounts can't be changed")
	// ErrNoLongerHeld means reversing the reservation would take more than
	// is held: the money has been moved on or released since.
	ErrNoLongerHeld = errors.New("the money is no longer held for savings")
	// ErrNotEnoughUnallocated means reserving the money again (reversing a
	// release) would take more than the account has unallocated.
	ErrNotEnoughUnallocated = errors.New("not enough unallocated money to hold it again")
)

// correctable are the types the user may correct and reverse.
var correctable = []sqlc.TransactionType{
	sqlc.TransactionTypeINC, sqlc.TransactionTypeEXP, sqlc.TransactionTypeTRF,
	sqlc.TransactionTypeOPB, sqlc.TransactionTypeBLA,
}

// reversible are the types the user may reverse: the correctable ones, and
// the savings module's (#231), which can't be corrected.
var reversible = append(slices.Clone(correctable),
	sqlc.TransactionTypeSVR, sqlc.TransactionTypeSVC, sqlc.TransactionTypeSVB, sqlc.TransactionTypeSVD)

// Changes are a correction's desired values; nil leaves a field as it is.
// Amounts are positive like in New, except for OPB and BLA, whose signed
// amount is the account's line. OPB and BLA only take Amount, Counterparty,
// Description and Tags.
type Changes struct {
	// AccountID and ToAccountID move the transaction to other accounts: it
	// is reversed and recorded again, replacing the original.
	AccountID   *string
	ToAccountID *string
	Amount      *decimal.Decimal
	// Buckets replaces all bucket lines when SetBuckets is true; an empty
	// list removes them.
	Buckets      []BucketAmount
	SetBuckets   bool
	Counterparty *string
	Description  *string
	Tags         *[]string
	// TriggersRefill sets whether an income triggers a refill: true refills
	// now, false undoes the refills it triggered in the active cycle.
	TriggersRefill *bool
	// BSUConfirmed is as in New (#214).
	BSUConfirmed bool
	// LimitConfirmed is as in New (#260).
	LimitConfirmed bool
}

// Correct records an adjustment that turns the transaction into what c
// describes: its lines hold the difference, dated at the original time. A
// correction's ID corrects its parent. Moving the transaction to another
// account reverses it and records a new transaction that replaces it; Correct
// then returns the new one.
func (s *Service) Correct(ctx context.Context, userID, id string, c Changes) (Transaction, error) {
	var outID string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		var err error
		outID, err = s.correct(ctx, tx, userID, id, c)
		return err
	})
	if err != nil {
		return Transaction{}, err
	}
	return s.Get(ctx, userID, outID)
}

// correct does Correct's work in tx, with the user locked. It returns the ID
// of the transaction that now stands for the corrected one.
func (s *Service) correct(ctx context.Context, tx pgx.Tx, userID, id string, c Changes) (string, error) {
	cur, err := s.lock(ctx, tx, userID, id, false)
	if err != nil {
		return "", err
	}
	want, err := desired(cur, c)
	if err != nil {
		return "", err
	}
	want.BSUConfirmed = c.BSUConfirmed
	want.LimitConfirmed = c.LimitConfirmed
	// A transfer that did Done on held savings keeps its amount and accounts,
	// so it and the money it took off hold stay alike.
	if len(cur.SavingsLines) > 0 {
		if cur.isMove(want) {
			return "", ErrSavingsTransfer
		}
		if bank, _, err := diff(cur, want); err != nil {
			return "", err
		} else if len(bank) > 0 {
			return "", ErrSavingsTransfer
		}
	}

	if cur.isMove(want) {
		if err := s.reverse(ctx, tx, userID, cur); err != nil {
			return "", err
		}
		t, err := s.record(ctx, tx, userID, want, cur.ID)
		if err != nil {
			return "", correctionError(err)
		}
		return t.Header.ID, nil
	}

	bank, buckets, err := diff(cur, want)
	if err != nil {
		return "", err
	}
	if len(bank) == 0 && len(buckets) == 0 && sameHeader(cur, want) {
		return "", ErrNoChange
	}
	q := sqlc.New(tx)
	if len(bank) > 0 {
		if err := checkAccounts(ctx, q, userID, want); err != nil {
			return "", err
		}
	}
	// Buckets that keep or get a line must be funded from the account;
	// removing a line needs no check beyond the ledger's.
	changed := want
	changed.Buckets = nil
	for _, l := range buckets {
		if slices.ContainsFunc(want.Buckets, func(b BucketAmount) bool { return b.BucketID == l.BucketID }) {
			changed.Buckets = append(changed.Buckets, BucketAmount{BucketID: l.BucketID})
		}
	}
	if err := checkBuckets(ctx, q, userID, changed); err != nil {
		return "", err
	}
	if err := checkBSU(ctx, tx, userID, want, cur.BankLines, isInterest(cur)); err != nil {
		return "", err
	}
	if err := checkCard(ctx, tx, userID, want, cur.BankLines); err != nil {
		return "", err
	}
	if _, err := s.ledger.Record(ctx, tx, ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: cur.Type, Correction: sqlc.CorrectionTypeAdjustment,
		ParentID: cur.ID, At: cur.At, Counterparty: want.Counterparty, Description: want.Description, Tags: want.Tags,
		TriggersRefill: *want.TriggersRefill, BankLines: bank, BucketLines: buckets,
	}); err != nil {
		return "", correctionError(err)
	}
	if s.refills == nil || *want.TriggersRefill == cur.TriggersRefill {
		return cur.ID, nil
	}
	if *want.TriggersRefill {
		return cur.ID, s.refills.OnIncome(ctx, tx, userID, cur.ID, want.AccountID, cur.At, true)
	}
	return cur.ID, s.refills.UndoIncome(ctx, tx, userID, cur.ID)
}

// Reverse records a reversal that negates every effective line of the
// transaction, dated at the original time.
func (s *Service) Reverse(ctx context.Context, userID, id string) (Transaction, error) {
	var root string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		cur, err := s.lock(ctx, tx, userID, id, true)
		if err != nil {
			return err
		}
		root = cur.ID
		return s.reverse(ctx, tx, userID, cur)
	})
	if err != nil {
		return Transaction{}, err
	}
	return s.Get(ctx, userID, root)
}

func (s *Service) reverse(ctx context.Context, tx pgx.Tx, userID string, cur Transaction) error {
	if len(cur.BankLines) == 0 && len(cur.BucketLines) == 0 && len(cur.SavingsLines) == 0 {
		return fmt.Errorf("%w: the transaction has no amounts left to reverse", ErrNoChange)
	}
	if err := checkSavingsReversal(ctx, tx, userID, cur); err != nil {
		return err
	}
	e := ledger.Entry{
		UserID: userID, CreatedBy: userID, Type: cur.Type, Correction: sqlc.CorrectionTypeReversal,
		ParentID: cur.ID, At: cur.At, Counterparty: cur.Counterparty, Description: cur.Description, Tags: cur.Tags,
		TriggersRefill: cur.TriggersRefill,
	}
	for _, l := range cur.BankLines {
		e.BankLines = append(e.BankLines, ledger.BankLine{AccountID: l.AccountID, Amount: l.Amount.Neg()})
	}
	for _, l := range cur.BucketLines {
		e.BucketLines = append(e.BucketLines, ledger.BucketLine{BucketID: l.BucketID, Amount: l.Amount.Neg()})
	}
	for _, l := range cur.SavingsLines {
		e.SavingsLines = append(e.SavingsLines, ledger.SavingsLine{HolderID: l.HolderID, AccountID: l.AccountID, Amount: l.Amount.Neg()})
	}
	if _, err := s.ledger.Record(ctx, tx, e); err != nil {
		return correctionError(err)
	}
	// Reversing (or moving) an income undoes the refills it triggered.
	if cur.TriggersRefill && s.refills != nil {
		return s.refills.UndoIncome(ctx, tx, userID, cur.ID)
	}
	return nil
}

// lock locks the original transaction of id (a correction's ID locks its
// parent) and returns it merged with its corrections and with its history.
// It fails if the transaction can't be corrected, or with reversing, if it
// can't be reversed.
func (s *Service) lock(ctx context.Context, tx pgx.Tx, userID, id string, reversing bool) (Transaction, error) {
	q := sqlc.New(tx)
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
	if _, err := q.LockTransactionHeader(ctx, sqlc.LockTransactionHeaderParams{ID: id, UserID: userID}); err != nil {
		return Transaction{}, err
	}
	list, err := s.load(ctx, q, userID, []string{id}, true)
	if err != nil {
		return Transaction{}, err
	}
	cur := list[0]
	allowed := correctable
	if reversing {
		allowed = reversible
	}
	if !slices.Contains(allowed, cur.Type) {
		return Transaction{}, fmt.Errorf("%w: %s", ErrNotCorrectable, cur.Type)
	}
	if cur.Reversed {
		return Transaction{}, ErrAlreadyReversed
	}
	// Nothing with a locked BSU account changes until it's set up (#214).
	var accounts []string
	for _, v := range cur.History {
		for _, l := range v.BankLines {
			accounts = append(accounts, l.AccountID)
		}
	}
	if err := bsu.Locked(ctx, tx, userID, accounts...); err != nil {
		return Transaction{}, err
	}
	return cur, nil
}

// desired returns the transaction as c wants it, in New's terms (positive
// amounts), checked against the rules that don't need the database.
func desired(cur Transaction, c Changes) (New, error) {
	n := New{
		Type: cur.Type, At: cur.At, Counterparty: cur.Counterparty, Description: cur.Description, Tags: cur.Tags,
		TriggersRefill: &cur.TriggersRefill,
	}
	if c.TriggersRefill != nil {
		n.TriggersRefill = c.TriggersRefill
	}
	if c.Counterparty != nil {
		n.Counterparty = *c.Counterparty
	}
	if c.Description != nil {
		n.Description = *c.Description
	}
	if c.Tags != nil {
		n.Tags = *c.Tags
	}

	if cur.Type == sqlc.TransactionTypeOPB || cur.Type == sqlc.TransactionTypeBLA {
		if c.AccountID != nil || c.ToAccountID != nil || c.SetBuckets || c.TriggersRefill != nil {
			return New{}, fmt.Errorf("%w: only the amount, counterparty, description and tags of a %s can change", ErrInvalid, cur.Type)
		}
		// The account is the original line's; the effective line is gone
		// when the amount was corrected to 0.
		n.AccountID = cur.History[0].BankLines[0].AccountID
		n.Amount = decimal.Zero
		if len(cur.BankLines) > 0 {
			n.Amount = cur.BankLines[0].Amount
		}
		if c.Amount != nil {
			n.Amount = *c.Amount
		}
		if err := money.Valid(n.Amount); err != nil {
			return New{}, fmt.Errorf("%w: amount: %w", ErrInvalid, err)
		}
		return n, nil
	}

	sign := decimal.NewFromInt(1)
	switch cur.Type {
	case sqlc.TransactionTypeEXP:
		sign = sign.Neg()
		fallthrough
	case sqlc.TransactionTypeINC:
		n.AccountID = cur.BankLines[0].AccountID
		n.Amount = cur.BankLines[0].Amount.Mul(sign)
		for _, l := range cur.BucketLines {
			n.Buckets = append(n.Buckets, BucketAmount{BucketID: l.BucketID, Amount: l.Amount.Mul(sign)})
		}
	case sqlc.TransactionTypeTRF:
		for _, l := range cur.BankLines {
			if l.Amount.IsNegative() {
				n.AccountID, n.Amount = l.AccountID, l.Amount.Neg()
			} else {
				n.ToAccountID = l.AccountID
			}
		}
	}
	if c.AccountID != nil {
		n.AccountID = *c.AccountID
	}
	if c.ToAccountID != nil {
		n.ToAccountID = *c.ToAccountID
	}
	if c.Amount != nil {
		n.Amount = *c.Amount
	}
	if c.SetBuckets {
		n.Buckets = c.Buckets
	}
	if _, _, err := signedLines(n); err != nil {
		return New{}, err
	}
	return n, nil
}

// isMove reports whether want is on other accounts than t.
func (t Transaction) isMove(want New) bool {
	switch t.Type {
	case sqlc.TransactionTypeINC, sqlc.TransactionTypeEXP:
		return want.AccountID != t.BankLines[0].AccountID
	case sqlc.TransactionTypeTRF:
		for _, l := range t.BankLines {
			if l.Amount.IsNegative() && l.AccountID != want.AccountID || l.Amount.IsPositive() && l.AccountID != want.ToAccountID {
				return true
			}
		}
	}
	return false
}

// diff returns the lines that turn cur into want: desired − effective, per
// account and bucket, leaving out zeros.
func diff(cur Transaction, want New) ([]ledger.BankLine, []ledger.BucketLine, error) {
	var bank []ledger.BankLine
	var buckets []ledger.BucketLine
	if cur.Type == sqlc.TransactionTypeOPB || cur.Type == sqlc.TransactionTypeBLA {
		bank = []ledger.BankLine{{AccountID: want.AccountID, Amount: want.Amount}}
	} else {
		var err error
		if bank, buckets, err = signedLines(want); err != nil {
			return nil, nil, err
		}
	}

	var bankDiff []ledger.BankLine
	for _, l := range bank {
		d := l.Amount
		if i := slices.IndexFunc(cur.BankLines, func(c BankLine) bool { return c.AccountID == l.AccountID }); i >= 0 {
			d = d.Sub(cur.BankLines[i].Amount)
		}
		if !d.IsZero() {
			bankDiff = append(bankDiff, ledger.BankLine{AccountID: l.AccountID, Amount: d})
		}
	}
	// Effective lines on accounts the desired state doesn't have can only
	// come from OPB and BLA, whose account never changes; isMove handles
	// the rest.

	var bucketDiff []ledger.BucketLine
	for _, l := range buckets {
		d := l.Amount
		if i := slices.IndexFunc(cur.BucketLines, func(c BucketLine) bool { return c.BucketID == l.BucketID }); i >= 0 {
			d = d.Sub(cur.BucketLines[i].Amount)
		}
		if !d.IsZero() {
			bucketDiff = append(bucketDiff, ledger.BucketLine{BucketID: l.BucketID, Amount: d})
		}
	}
	for _, c := range cur.BucketLines {
		if !slices.ContainsFunc(buckets, func(l ledger.BucketLine) bool { return l.BucketID == c.BucketID }) {
			bucketDiff = append(bucketDiff, ledger.BucketLine{BucketID: c.BucketID, Amount: c.Amount.Neg()})
		}
	}
	return bankDiff, bucketDiff, nil
}

// sameHeader reports whether want has t's counterparty, description and
// tags, the way the ledger stores them: trimmed, and tags reused by name
// ignoring case.
func sameHeader(t Transaction, want New) bool {
	if strings.TrimSpace(want.Counterparty) != t.Counterparty || ledger.CleanDescription(want.Description) != t.Description ||
		*want.TriggersRefill != t.TriggersRefill {
		return false
	}
	norm := func(tags []string) []string {
		var out []string
		for _, tag := range tags {
			if tag = strings.ToLower(strings.TrimSpace(tag)); tag != "" && !slices.Contains(out, tag) {
				out = append(out, tag)
			}
		}
		slices.Sort(out)
		return out
	}
	return slices.Equal(norm(want.Tags), norm(t.Tags))
}

// correctionError explains the ledger's errors for a correction. It is dated
// at the original time, so it can only touch buckets while that time is in
// the active cycle; and the accounts and buckets it touches may have been
// deleted since.
func correctionError(err error) error {
	switch {
	case errors.Is(err, ledger.ErrNoActiveCycle), errors.Is(err, ledger.ErrOutsideCycle):
		return fmt.Errorf("%w: %w", ErrBucketLinesLocked, err)
	case errors.Is(err, ledger.ErrNotFound):
		return fmt.Errorf("%w: an account, bucket or savings target of the transaction has been deleted (%w)", ErrInvalid, err)
	}
	return err
}

// checkSavingsReversal checks what reversing cur does to savings (#231).
// Taking a reservation back can't leave less than nothing held, which it
// would once the money has been moved on or released. Reserving released
// money again (reversing an SVC) needs it to be unallocated still; a
// reversal with bank lines brings its money back along, and reversing a
// distribution (SVD, #232) only moves money from the targets back to the
// distributor.
func checkSavingsReversal(ctx context.Context, tx pgx.Tx, userID string, cur Transaction) error {
	if len(cur.SavingsLines) == 0 {
		return nil
	}
	q := sqlc.New(tx)
	held, err := q.SavingsHeld(ctx, userID)
	if err != nil {
		return err
	}
	heldOn := func(holder, account string) decimal.Decimal {
		for _, h := range held {
			if h.HolderID == holder && h.AccountID == account {
				return h.Held
			}
		}
		return decimal.Zero
	}
	var free map[string]balance.Money
	for _, l := range cur.SavingsLines {
		if l.Amount.IsPositive() {
			if heldOn(l.HolderID, l.AccountID).LessThan(l.Amount) {
				return ErrNoLongerHeld
			}
			continue
		}
		if len(cur.BankLines) > 0 || len(cur.BucketLines) > 0 || cur.Type == sqlc.TransactionTypeSVD {
			continue
		}
		if free == nil {
			if free, err = balance.AccountMoney(ctx, tx, userID); err != nil {
				return err
			}
		}
		if free[l.AccountID].Unallocated.LessThan(l.Amount.Neg()) {
			return ErrNotEnoughUnallocated
		}
	}
	return nil
}
