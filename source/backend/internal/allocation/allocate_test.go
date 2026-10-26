package allocation_test

import (
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func b(id, tf string, importance int, priority bool) allocation.Bucket {
	return allocation.Bucket{ID: id, TF: dec(tf), Importance: importance, Priority: priority}
}

func TestAllocate(t *testing.T) {
	for name, tc := range map[string]struct {
		available string
		buckets   []allocation.Bucket
		want      map[string]string
	}{
		"enough": {"1000", []allocation.Bucket{b("a", "300", 5, false), b("b", "200", 5, false)},
			map[string]string{"a": "300", "b": "200"}},
		"exactly enough": {"500", []allocation.Bucket{b("a", "300", 5, false), b("b", "200", 1, false)},
			map[string]string{"a": "300", "b": "200"}},
		"by weight": {"300", []allocation.Bucket{b("a", "400", 5, false), b("b", "200", 5, false)},
			map[string]string{"a": "200", "b": "100"}},
		"importance": {"300", []allocation.Bucket{b("a", "400", 1, false), b("b", "400", 2, false)},
			map[string]string{"a": "100", "b": "200"}},
		// a's share (250) exceeds its TF; the excess goes to b.
		"capped": {"500", []allocation.Bucket{b("a", "100", 10, false), b("b", "1000", 1, false)},
			map[string]string{"a": "100", "b": "400"}},
		"priority first": {"1000", []allocation.Bucket{b("p", "800", 1, true), b("a", "500", 5, false), b("b", "500", 5, false)},
			map[string]string{"p": "800", "a": "100", "b": "100"}},
		"priority underfunded": {"600", []allocation.Bucket{b("p1", "800", 5, true), b("p2", "400", 5, true), b("a", "100", 10, false)},
			map[string]string{"p1": "400", "p2": "200", "a": "0"}},
		"TF not positive": {"100", []allocation.Bucket{b("a", "-50", 5, false), b("b", "0", 5, true), b("c", "300", 5, false)},
			map[string]string{"a": "0", "b": "0", "c": "100"}},
		"overdrawn": {"-200", []allocation.Bucket{b("a", "300", 5, false)},
			map[string]string{"a": "0"}},
		// 33.333… each; the leftover cent goes to the first ID on a tie.
		"cents": {"100", []allocation.Bucket{b("c", "100", 1, false), b("a", "100", 1, false), b("b", "100", 1, false)},
			map[string]string{"a": "33.34", "b": "33.33", "c": "33.33"}},
		"no buckets": {"100", nil, map[string]string{}},
	} {
		got := allocation.Allocate(dec(tc.available), tc.buckets)
		if len(got) != len(tc.want) {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
			continue
		}
		for id, want := range tc.want {
			if !got[id].Equal(dec(want)) {
				t.Errorf("%s: %s = %s, want %s", name, id, got[id], want)
			}
		}
	}
}

// TestAllocateProperties checks the invariants of #17 on random inputs.
func TestAllocateProperties(t *testing.T) {
	r := rand.New(rand.NewPCG(17, 17))
	cents := func(lo, hi int64) decimal.Decimal { return decimal.New(lo+r.Int64N(hi-lo+1), -money.Places) }
	for i := range 5000 {
		buckets := make([]allocation.Bucket, 1+r.IntN(8))
		positive := decimal.Zero
		for j := range buckets {
			buckets[j] = allocation.Bucket{
				ID: fmt.Sprintf("b%d", j), TF: cents(-10000, 500000),
				Importance: 1 + r.IntN(10), Priority: r.IntN(3) == 0,
			}
			positive = positive.Add(decimal.Max(buckets[j].TF, decimal.Zero))
		}
		available := cents(-50000, 1500000)
		got := allocation.Allocate(available, buckets)

		sum := decimal.Zero
		prioFull, restFunded := true, false
		for _, bk := range buckets {
			caf := got[bk.ID]
			if caf.IsNegative() || caf.GreaterThan(decimal.Max(bk.TF, decimal.Zero)) {
				t.Fatalf("case %d: %s CAF %s outside 0..max(TF %s, 0)", i, bk.ID, caf, bk.TF)
			}
			if !caf.Equal(caf.Round(money.Places)) {
				t.Fatalf("case %d: %s CAF %s has more than 2 decimals", i, bk.ID, caf)
			}
			if bk.Priority && bk.TF.IsPositive() && !caf.Equal(bk.TF) {
				prioFull = false
			}
			if !bk.Priority && caf.IsPositive() {
				restFunded = true
			}
			sum = sum.Add(caf)
		}
		// Every cent available is used, up to the total positive TF.
		if want := decimal.Min(decimal.Max(available, decimal.Zero), positive); !sum.Equal(want) {
			t.Fatalf("case %d: Σ CAF %s, want %s (available %s, Σ TF %s)", i, sum, want, available, positive)
		}
		if restFunded && !prioFull {
			t.Fatalf("case %d: a non-priority bucket got money before the priority buckets were full: %v", i, got)
		}
	}
}

func TestNeeded(t *testing.T) {
	stored := func(id, tf, caf string) allocation.Bucket {
		return allocation.Bucket{ID: id, TF: dec(tf), CAF: dec(caf), Importance: 5}
	}
	for name, tc := range map[string]struct {
		available string
		buckets   []allocation.Bucket
		want      bool
	}{
		"fully funded":          {"1000", []allocation.Bucket{stored("a", "300", "300")}, false},
		"covers TF, CAF behind": {"1000", []allocation.Bucket{stored("a", "300", "100")}, true},
		"CAF above available":   {"200", []allocation.Bucket{stored("a", "300", "250")}, true},
		"underfunded, stable":   {"200.50", []allocation.Bucket{stored("a", "300", "200")}, false},
		// Unallocated money alone doesn't move CAF: only a trigger (Follow) or
		// a reallocation by hand does.
		"unallocated":  {"250", []allocation.Bucket{stored("a", "300", "200")}, false},
		"CAF above TF": {"250", []allocation.Bucket{stored("a", "250", "300"), stored("b", "200", "0")}, false},
		"overdrawn":    {"-10", []allocation.Bucket{stored("a", "300", "0")}, false},
		"no buckets":   {"100", nil, false},
	} {
		if got := allocation.Needed(dec(tc.available), tc.buckets); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}

func TestFollow(t *testing.T) {
	stored := func(id, tf, caf string) allocation.Bucket {
		return allocation.Bucket{ID: id, TF: dec(tf), CAF: dec(caf), Importance: 5}
	}
	lines := func(bank string, buckets ...string) allocation.Lines {
		l := allocation.Lines{Banked: bank != "", Buckets: map[string]decimal.Decimal{}}
		if bank != "" {
			l.Bank = dec(bank)
		}
		for i := 0; i < len(buckets); i += 2 {
			l.Buckets[buckets[i]] = dec(buckets[i+1])
		}
		return l
	}
	// Balance 400 for Σ TF 600 before each case, all of it allocated:
	// a 300 of TF 400, b 100 of TF 200.
	for name, tc := range map[string]struct {
		available string
		tf        [2]string
		lines     allocation.Lines
		want      bool
		caf       [2]string
	}{
		"expense from a bucket": {"350", [2]string{"350", "200"}, lines("-50", "a", "-50"), false, [2]string{"250", "100"}},
		"income into a bucket":  {"450", [2]string{"450", "200"}, lines("50", "a", "50"), false, [2]string{"350", "100"}},
		"split over two":        {"300", [2]string{"340", "160"}, lines("-100", "a", "-60", "b", "-40"), false, [2]string{"240", "60"}},
		"part not on a bucket":  {"300", [2]string{"360", "200"}, lines("-100", "a", "-40"), true, [2]string{"260", "100"}},
		"outside expense":       {"390", [2]string{"400", "200"}, lines("-10"), true, [2]string{"300", "100"}},
		"outside income":        {"410", [2]string{"400", "200"}, lines("10"), true, [2]string{"300", "100"}},
		"CAF spent":             {"300", [2]string{"400", "100"}, lines("-100", "b", "-100"), true, [2]string{"300", "0"}},
		"CAF overspent":         {"250", [2]string{"400", "50"}, lines("-150", "b", "-150"), true, [2]string{"300", "-50"}},
		// A refill raises TF without money: CAF stays while underfunded.
		"refill, underfunded": {"400", [2]string{"400", "300"}, lines("", "b", "100"), false, [2]string{"300", "100"}},
	} {
		buckets := []allocation.Bucket{stored("a", tc.tf[0], "300"), stored("b", tc.tf[1], "100")}
		if got := allocation.Follow(dec(tc.available), buckets, tc.lines); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
		if got := [2]string{buckets[0].CAF.String(), buckets[1].CAF.String()}; got != tc.caf {
			t.Errorf("%s: CAF %v, want %v", name, got, tc.caf)
		}
	}

	// Covered (balance 700 for Σ TF 600) until a refill of 200 on b: it
	// crosses Σ TF.
	covered := []allocation.Bucket{stored("a", "400", "400"), stored("b", "400", "200")}
	if !allocation.Follow(dec("700"), covered, lines("", "b", "200")) {
		t.Error("a refill that leaves the account underfunded should recalculate")
	}
	// A bucket line moves the balance and TF together, so it never crosses.
	still := []allocation.Bucket{stored("a", "600", "600")}
	if allocation.Follow(dec("700"), still, lines("-100", "a", "-100")) {
		t.Error("an expense from a bucket of a covered account shouldn't recalculate")
	}
	// An income into an overspent bucket pays its debt first.
	debt := []allocation.Bucket{stored("a", "30", "0")}
	if !allocation.Follow(dec("30"), debt, lines("50", "a", "50")) {
		t.Error("an income into an overspent bucket should recalculate")
	}
}

func TestClamp(t *testing.T) {
	for _, tc := range []struct{ tf, caf, want string }{
		{"300", "200", "200"}, {"300", "400", "300"}, {"-50", "20", "0"}, {"100", "-5", "0"},
	} {
		if got := allocation.Clamp(allocation.Bucket{TF: dec(tc.tf), CAF: dec(tc.caf)}); !got.Equal(dec(tc.want)) {
			t.Errorf("Clamp(TF %s, CAF %s) = %s, want %s", tc.tf, tc.caf, got, tc.want)
		}
	}
}
