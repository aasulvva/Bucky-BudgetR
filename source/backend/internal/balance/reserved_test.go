package balance_test

import (
	"testing"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
)

// TestNewMoney: card debt held on an account (#261) is covered first, then
// the buckets' CAF, then savings reservations.
func TestNewMoney(t *testing.T) {
	d := decimal.RequireFromString
	for _, c := range []struct {
		name                                    string
		bal, waiting                            string
		holds                                   map[string]decimal.Decimal
		allocated, reserved                     string
		debt, cardCovered, covered, unallocated string
		forBuckets                              string
	}{
		{"no card debt", "1000", "0", nil, "300", "200", "0", "0", "200", "500", "1000"},
		{"card debt first", "1000", "0", map[string]decimal.Decimal{"9000": d("400")}, "300", "200", "400", "400", "200", "100", "600"},
		{"savings short", "1000", "0", map[string]decimal.Decimal{"9000": d("600")}, "300", "200", "600", "600", "100", "0", "400"},
		{"card debt not covered", "500", "0", map[string]decimal.Decimal{"9000": d("400"), "9001": d("300")}, "0", "100", "700", "500", "0", "0", "-200"},
		{"a credit hold counts as none", "1000", "0", map[string]decimal.Decimal{"9000": d("-50")}, "0", "0", "0", "0", "0", "1000", "1000"},
		// What buckets owe the account for waiting purchases (#264) counts as
		// money there: the 300 spent and still owed leaves unallocated as it was.
		{"waiting", "700", "300", nil, "300", "200", "0", "0", "200", "500", "1000"},
		{"waiting covers card debt", "0", "400", map[string]decimal.Decimal{"9000": d("400")}, "0", "0", "400", "400", "0", "0", "0"},
		{"holds net out", "1000", "0", map[string]decimal.Decimal{"9000": d("-50"), "9001": d("150")}, "0", "0", "100", "100", "0", "900", "900"},
	} {
		m := balance.NewMoney(d(c.bal), d(c.waiting), c.holds, d(c.allocated), d(c.reserved))
		for what, pair := range map[string][2]decimal.Decimal{
			"card debt":    {m.CardDebt, d(c.debt)},
			"card covered": {m.CardCovered, d(c.cardCovered)},
			"covered":      {m.Covered, d(c.covered)},
			"unallocated":  {m.Unallocated, d(c.unallocated)},
			"for buckets":  {m.ForBuckets(), d(c.forBuckets)},
		} {
			if !pair[0].Equal(pair[1]) {
				t.Errorf("%s: %s %s, want %s", c.name, what, pair[0], pair[1])
			}
		}
	}
}
