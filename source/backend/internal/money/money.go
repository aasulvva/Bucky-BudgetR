// Package money holds the rules for amounts (spec §5.5).
//
// Amounts are shopspring/decimal values, never float64. Calculate at full
// precision and round only the result, with Round, before it is stored. The
// database stores amounts as NUMERIC(14,2) and exchange rates as
// NUMERIC(18,8). The ledger rejects amounts that aren't already rounded
// (Valid), so nothing is rounded silently on the way in.
//
// Rounding is half away from zero: 0.005 → 0.01 and −0.005 → −0.01. That is
// what people expect, and it is also what PostgreSQL does when it casts to
// numeric(p,2), so Go and SQL agree.
package money

import (
	"errors"
	"fmt"
	"regexp"
	"slices"

	"github.com/shopspring/decimal"
	"golang.org/x/text/currency"
)

const (
	// Places is the number of decimals stored for an amount.
	Places = 2
	// RatePlaces is the number of decimals stored for an exchange rate.
	RatePlaces = 8
)

var (
	// ErrPrecision means an amount has more than Places decimals.
	ErrPrecision = errors.New("amount has more than 2 decimals")
	// ErrRange means an amount doesn't fit NUMERIC(14,2).
	ErrRange = errors.New("amount is too large")
	// ErrCurrency means a currency code isn't supported.
	ErrCurrency = errors.New("unsupported currency")

	limit = decimal.New(1, 12) // NUMERIC(14,2) holds |x| < 10^12
)

// Round rounds d to Places decimals, half away from zero.
func Round(d decimal.Decimal) decimal.Decimal { return d.Round(Places) }

// Valid reports whether d can be stored as an amount as it is.
func Valid(d decimal.Decimal) error {
	if !d.Equal(Round(d)) {
		return fmt.Errorf("%w: %s", ErrPrecision, d)
	}
	if d.Abs().GreaterThanOrEqual(limit) {
		return fmt.Errorf("%w: %s", ErrRange, d)
	}
	return nil
}

var currencyRE = regexp.MustCompile(`^[A-Z]{3}$`)

// notCurrencies are ISO 4217 codes for things that aren't money you hold in
// an account: precious metals, SDRs, bond-market units and testing codes.
var notCurrencies = []string{
	"XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU", "XTS", "XUA", "XXX",
}

// ValidCurrency reports whether code is an ISO 4217 currency that amounts
// can be stored in: upper case, a real currency (not gold or a test code),
// with at most Places decimals. Currencies with 3 decimals, such as KWD,
// are rejected because their amounts can't be stored exactly.
func ValidCurrency(code string) error {
	if !currencyRE.MatchString(code) || slices.Contains(notCurrencies, code) {
		return fmt.Errorf("%w: %q", ErrCurrency, code)
	}
	unit, err := currency.ParseISO(code)
	if err != nil {
		return fmt.Errorf("%w: %q", ErrCurrency, code)
	}
	if scale, _ := currency.Standard.Rounding(unit); scale > Places {
		return fmt.Errorf("%w: %s uses %d decimals, at most %d are supported", ErrCurrency, code, scale, Places)
	}
	return nil
}

// Rate is the exchange rate from the original currency to the account
// currency: amount / original, rounded to RatePlaces. Signs are ignored.
// original must not be zero.
func Rate(amount, original decimal.Decimal) decimal.Decimal {
	return amount.Abs().DivRound(original.Abs(), RatePlaces)
}
