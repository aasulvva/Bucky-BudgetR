// Package cards holds what's particular to credit card accounts (#260, spec
// §2.2): their fields, what's owed and available, the lock while a card has
// no bill account, and the check that a transaction doesn't take a card's
// debt past its credit limit unless it's confirmed.
package cards

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// LastDay is the statement or due day that means the last day of the month.
const LastDay = 31

// NearShare is the share of the credit limit, in percent, at which a card's
// debt gets a notification.
const NearShare = 90

// BillAccountTypes are the types a card's bill account can have.
var BillAccountTypes = []sqlc.AccountType{sqlc.AccountTypeUsage, sqlc.AccountTypeSavings}

// Errors returned by the package.
var (
	// ErrLocked means a card has no bill account (it was deleted or changed
	// type): nothing may be recorded with it until it gets one. Deleting it
	// still works.
	ErrLocked = errors.New("the credit card is locked until it gets a bill account")
	// ErrOverLimit is wrapped by *OverLimitError.
	ErrOverLimit = errors.New("this takes the credit card past its credit limit")
	// ErrInvalid means a card's fields break a rule.
	ErrInvalid = errors.New("invalid credit card")
	// ErrBillAccount means the bill account isn't a live usage or savings
	// account of the user's in the card's currency.
	ErrBillAccount = errors.New("the bill account must be a usage or savings account in the card's currency")
	// ErrSource means a card would fund a bucket or hold savings: it has no
	// money of its own to give.
	ErrSource = errors.New("a credit card can't be a bucket's source or a savings source")
	// ErrTypeChange means an account would change to or from a credit card.
	ErrTypeChange = errors.New("an account can't change to or from a credit card")
)

// LockedError says which card is locked.
type LockedError struct{ AccountID string }

func (e *LockedError) Error() string { return fmt.Sprintf("%s: account %s", ErrLocked, e.AccountID) }

func (e *LockedError) Unwrap() error { return ErrLocked }

// OverLimitError says which card would go past its limit, and what's
// available on it now.
type OverLimitError struct {
	AccountID string
	Available decimal.Decimal
}

func (e *OverLimitError) Error() string {
	return fmt.Sprintf("%s: account %s has %s available", ErrOverLimit, e.AccountID, e.Available.StringFixed(money.Places))
}

func (e *OverLimitError) Unwrap() error { return ErrOverLimit }

// Fields are a card's own fields.
type Fields struct {
	// BillAccountID is the account the bill is paid from; "" while locked.
	BillAccountID  string
	CreditLimit    decimal.Decimal
	StatementDay   int
	DueDay         int
	MinimumPayment decimal.Decimal
}

// Status is a card's fields and what's owed on it.
type Status struct {
	Fields
	// Owed is −balance, at least 0.
	Owed decimal.Decimal
	// Available is the credit left: the limit plus the balance; below 0
	// past the limit.
	Available decimal.Decimal
	Locked    bool
}

// UsedPercent is the share of the limit owed, in percent.
func (s Status) UsedPercent() decimal.Decimal {
	return s.Owed.Mul(decimal.NewFromInt(100)).Div(s.CreditLimit)
}

// ValidDay reports whether d is a statement or due day: 1–28 or LastDay.
func ValidDay(d int) bool { return (d >= 1 && d <= 28) || d == LastDay }

// CheckFields checks f's own rules; the bill account is checked against the
// database by CheckBillAccount.
func CheckFields(f Fields) error {
	if err := money.Valid(f.CreditLimit); err != nil || !f.CreditLimit.IsPositive() {
		return fmt.Errorf("%w: the credit limit must be above 0", ErrInvalid)
	}
	if err := money.Valid(f.MinimumPayment); err != nil || !f.MinimumPayment.IsPositive() {
		return fmt.Errorf("%w: the minimum payment must be above 0", ErrInvalid)
	}
	if !ValidDay(f.StatementDay) || !ValidDay(f.DueDay) {
		return fmt.Errorf("%w: the statement and due days are 1–28, or %d for the last day of the month", ErrInvalid, LastDay)
	}
	return nil
}

// CheckBillAccount checks that id is a live usage or savings account of the
// user's in currency, other than the card itself.
func CheckBillAccount(ctx context.Context, db sqlc.DBTX, userID, cardID, id, currency string) error {
	if id == "" || id == cardID {
		return ErrBillAccount
	}
	a, err := sqlc.New(db).GetAccount(ctx, sqlc.GetAccountParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrBillAccount
	}
	if err != nil {
		return err
	}
	if a.Currency != currency || !slices.Contains(BillAccountTypes, a.AccountType) {
		return ErrBillAccount
	}
	return nil
}

// Columns are f as the bank_accounts columns hold it; all invalid for a
// nil f (an account that isn't a card).
type Columns struct {
	BillAccountID  pgtype.Text
	CreditLimit    decimal.NullDecimal
	StatementDay   pgtype.Int2
	DueDay         pgtype.Int2
	MinimumPayment decimal.NullDecimal
}

// ToColumns returns f's columns.
func ToColumns(f *Fields) Columns {
	if f == nil {
		return Columns{}
	}
	return Columns{
		BillAccountID:  pgtype.Text{String: f.BillAccountID, Valid: f.BillAccountID != ""},
		CreditLimit:    decimal.NullDecimal{Decimal: f.CreditLimit, Valid: true},
		StatementDay:   pgtype.Int2{Int16: int16(f.StatementDay), Valid: true}, //nolint:gosec // 1–31
		DueDay:         pgtype.Int2{Int16: int16(f.DueDay), Valid: true},       //nolint:gosec // 1–31
		MinimumPayment: decimal.NullDecimal{Decimal: f.MinimumPayment, Valid: true},
	}
}

// FieldsOf returns a card's fields, and false for an account that isn't one.
func FieldsOf(a sqlc.BankAccount) (Fields, bool) {
	if a.AccountType != sqlc.AccountTypeCreditCard {
		return Fields{}, false
	}
	return Fields{
		BillAccountID:  a.CardBillAccountID.String,
		CreditLimit:    a.CardCreditLimit.Decimal,
		StatementDay:   int(a.CardStatementDay.Int16),
		DueDay:         int(a.CardDueDay.Int16),
		MinimumPayment: a.CardMinimumPayment.Decimal,
	}, true
}

// StatusOf returns a card's status at balance bal, and false for an account
// that isn't a card.
func StatusOf(a sqlc.BankAccount, bal decimal.Decimal) (Status, bool) {
	f, ok := FieldsOf(a)
	if !ok {
		return Status{}, false
	}
	return Status{
		Fields:    f,
		Owed:      decimal.Max(bal.Neg(), decimal.Zero),
		Available: f.CreditLimit.Add(bal),
		Locked:    f.BillAccountID == "",
	}, true
}

// Locked returns *LockedError for the first of accountIDs (in order) that's
// a locked card, else nil. Empty IDs are skipped.
func Locked(ctx context.Context, db sqlc.DBTX, userID string, accountIDs ...string) error {
	if !slices.ContainsFunc(accountIDs, func(id string) bool { return id != "" }) {
		return nil
	}
	locked, err := sqlc.New(db).ListLockedCards(ctx, userID)
	if err != nil {
		return err
	}
	for _, id := range accountIDs {
		if id != "" && slices.Contains(locked, id) {
			return &LockedError{AccountID: id}
		}
	}
	return nil
}

// Change is a transaction family's net on an account before and after it's
// recorded or corrected (Before is 0 for a new one).
type Change struct {
	AccountID     string
	Before, After decimal.Decimal
}

// Check checks the cards among changes: a change that takes more out of a
// card than before can't leave its balance below −limit
// (*OverLimitError). A change that lowers the debt, or one on a card
// already past its limit that adds nothing to it, passes. The caller holds
// the user's lock; balances are as of now.
func Check(ctx context.Context, db sqlc.DBTX, userID string, changes []Change) error {
	var more []Change
	for _, c := range changes {
		if c.After.LessThan(c.Before) {
			more = append(more, c)
		}
	}
	if len(more) == 0 {
		return nil
	}
	q := sqlc.New(db)
	var bal map[string]decimal.Decimal
	for _, c := range more {
		a, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: c.AccountID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			continue // the caller's own checks say so
		}
		if err != nil {
			return err
		}
		if a.AccountType != sqlc.AccountTypeCreditCard {
			continue
		}
		if bal == nil {
			if bal, err = balance.Accounts(ctx, db, userID); err != nil {
				return err
			}
		}
		st, _ := StatusOf(a, bal[a.ID])
		if after := st.Available.Add(c.After.Sub(c.Before)); after.IsNegative() {
			return &OverLimitError{AccountID: a.ID, Available: st.Available}
		}
	}
	return nil
}

// NotSource returns ErrSource if any of accountIDs is one of the user's
// cards, else nil.
func NotSource(ctx context.Context, db sqlc.DBTX, userID string, accountIDs ...string) error {
	if !slices.ContainsFunc(accountIDs, func(id string) bool { return id != "" }) {
		return nil
	}
	ids, err := sqlc.New(db).ListCardIDs(ctx, userID)
	if err != nil {
		return err
	}
	for _, id := range accountIDs {
		if id != "" && slices.Contains(ids, id) {
			return fmt.Errorf("%w: account %s", ErrSource, id)
		}
	}
	return nil
}
