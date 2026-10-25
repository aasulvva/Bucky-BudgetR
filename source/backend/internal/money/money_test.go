package money_test

import (
	"errors"
	"testing"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

func TestRound(t *testing.T) {
	for in, want := range map[string]string{
		"0.005":    "0.01",
		"-0.005":   "-0.01",
		"0.004999": "0",
		"1.005":    "1.01",
		"2.675":    "2.68", // 2.67 with float64
		"-2.675":   "-2.68",
		"0.015":    "0.02",
		"0.025":    "0.03", // half to even would give 0.02
		"100":      "100",
	} {
		got := money.Round(decimal.RequireFromString(in))
		if !got.Equal(decimal.RequireFromString(want)) {
			t.Errorf("Round(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestValid(t *testing.T) {
	for in, want := range map[string]error{
		"0.01":              nil,
		"-12.5":             nil,
		"999999999999.99":   nil,
		"-999999999999.99":  nil,
		"1.001":             money.ErrPrecision,
		"0.005":             money.ErrPrecision,
		"1000000000000":     money.ErrRange,
		"-1000000000000.00": money.ErrRange,
	} {
		if err := money.Valid(decimal.RequireFromString(in)); !errors.Is(err, want) {
			t.Errorf("Valid(%s) = %v, want %v", in, err, want)
		}
	}
}

func TestRate(t *testing.T) {
	for _, tc := range []struct{ amount, original, want string }{
		{"-115.32", "-10.00", "11.532"},
		{"100", "3", "33.33333333"},
		{"200", "3", "66.66666667"},
	} {
		got := money.Rate(decimal.RequireFromString(tc.amount), decimal.RequireFromString(tc.original))
		if !got.Equal(decimal.RequireFromString(tc.want)) {
			t.Errorf("Rate(%s, %s) = %s, want %s", tc.amount, tc.original, got, tc.want)
		}
	}
}

func TestValidCurrency(t *testing.T) {
	for code, ok := range map[string]bool{
		"NOK": true,
		"EUR": true,
		"USD": true,
		"JPY": true, // 0 decimals fit in 2
		"XOF": true, // a real currency, despite the X
		"nok": false,
		"NO":  false,
		"XYZ": false, // not ISO 4217
		"XAU": false, // gold
		"XTS": false, // testing code
		"KWD": false, // 3 decimals
		"":    false,
	} {
		err := money.ValidCurrency(code)
		if (err == nil) != ok {
			t.Errorf("ValidCurrency(%q) = %v, want ok=%v", code, err, ok)
		}
		if err != nil && !errors.Is(err, money.ErrCurrency) {
			t.Errorf("ValidCurrency(%q) = %v, want ErrCurrency", code, err)
		}
	}
}
