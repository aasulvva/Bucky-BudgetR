package savings

import (
	"testing"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func dp(s string) *decimal.Decimal {
	v := d(s)
	return &v
}

// from is a rule from a position with no end.
func from(f string, priority int) Rule { return Rule{From: d(f), Priority: priority} }

// between is a rule for a range.
func between(f, to string, priority int) Rule {
	return Rule{From: d(f), To: dp(to), Priority: priority}
}

func checkSplit(t *testing.T, amount string, cands []Candidate, want map[string]string, wantLeft string) {
	t.Helper()
	shares, left := Split(d(amount), cands)
	got := map[string]string{}
	for id, s := range shares {
		got[id] = s.StringFixed(2)
	}
	if len(got) != len(want) {
		t.Errorf("shares = %v, want %v", got, want)
	}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("share of %s = %s, want %s (all: %v)", id, got[id], w, got)
		}
	}
	if left.StringFixed(2) != wantLeft {
		t.Errorf("left = %s, want %s", left.StringFixed(2), wantLeft)
	}
	sum := left
	for _, s := range shares {
		sum = sum.Add(s)
	}
	if !sum.Equal(d(amount)) {
		t.Errorf("shares and left add up to %s, not %s", sum, amount)
	}
}

func TestSplit(t *testing.T) {
	// The example from the user's notes (#35): 6 + 4 + 2 = 12.
	down := Candidate{ID: "down", Position: d("107000"), Goal: d("500000"), Rules: []Rule{from("0", 6)}}
	buffer := Candidate{ID: "buffer", Position: d("38000"), Goal: d("100000"), Rules: []Rule{from("0", 4)}}
	hobby := Candidate{ID: "hobby", Position: d("11000"), Goal: d("50000"), Rules: []Rule{from("0", 2)}}

	t.Run("by priority, the leftover cent to the larger remainder", func(t *testing.T) {
		checkSplit(t, "5000", []Candidate{down, buffer, hobby},
			map[string]string{"down": "2500.00", "buffer": "1666.67", "hobby": "833.33"}, "0.00")
	})

	t.Run("in steps: a rule's edge, then the next rule's priority", func(t *testing.T) {
		b := buffer
		b.Position = d("39500")
		b.Rules = []Rule{between("30000", "40000", 4), from("40000", 1)}
		// Step 1: 1 500 in brings Buffer (4 of 12) to 40 000: 500 to it,
		// 750 to Down payment, 250 to Hobby. Step 2: the other 3 500 by
		// 6 + 1 + 2 = 9.
		checkSplit(t, "5000", []Candidate{down, b, hobby},
			map[string]string{"down": "3083.33", "buffer": "888.89", "hobby": "1027.78"}, "0.00")
	})

	t.Run("stops at the goal, and the rest goes to the others", func(t *testing.T) {
		h := hobby
		h.Position = d("49900")
		checkSplit(t, "1200", []Candidate{buffer, h},
			map[string]string{"buffer": "1100.00", "hobby": "100.00"}, "0.00")
	})

	t.Run("past the goal when the rule says so", func(t *testing.T) {
		h := hobby
		h.Position = d("49900")
		h.Rules = []Rule{{From: d("0"), Priority: 2, PastGoal: true}}
		checkSplit(t, "1200", []Candidate{buffer, h},
			map[string]string{"buffer": "800.00", "hobby": "400.00"}, "0.00")
	})

	t.Run("never past a bucket's capacity, even past the goal", func(t *testing.T) {
		h := Candidate{
			ID: "holiday", Position: d("2900"), Goal: d("2000"), Capacity: dp("3000"),
			Rules: []Rule{{From: d("0"), Priority: 1, PastGoal: true}},
		}
		checkSplit(t, "500", []Candidate{h}, map[string]string{"holiday": "100.00"}, "400.00")
	})

	t.Run("priority 0, a gap and no rule give nothing", func(t *testing.T) {
		zero := Candidate{ID: "zero", Position: d("100"), Goal: d("1000"), Rules: []Rule{from("0", 0)}}
		gap := Candidate{ID: "gap", Position: d("600"), Goal: d("1000"),
			Rules: []Rule{between("0", "500", 3), from("800", 3)}}
		none := Candidate{ID: "none", Position: d("0"), Goal: d("1000")}
		checkSplit(t, "300", []Candidate{zero, gap, none}, map[string]string{}, "300.00")
	})

	t.Run("what no target takes is left", func(t *testing.T) {
		h := hobby
		h.Position = d("49999.99")
		checkSplit(t, "10", []Candidate{h}, map[string]string{"hobby": "0.01"}, "9.99")
	})

	t.Run("thirds add up to the amount", func(t *testing.T) {
		a := Candidate{ID: "a", Goal: d("1000"), Rules: []Rule{from("0", 1)}}
		b := Candidate{ID: "b", Goal: d("1000"), Rules: []Rule{from("0", 1)}}
		c := Candidate{ID: "c", Goal: d("1000"), Rules: []Rule{from("0", 1)}}
		checkSplit(t, "100", []Candidate{a, b, c},
			map[string]string{"a": "33.34", "b": "33.33", "c": "33.33"}, "0.00")
	})

	t.Run("a target passes through several of its ranges", func(t *testing.T) {
		a := Candidate{ID: "a", Goal: d("10000"),
			Rules: []Rule{between("0", "100", 1), between("100", "200", 1), from("200", 1)}}
		checkSplit(t, "1000", []Candidate{a}, map[string]string{"a": "1000.00"}, "0.00")
	})
}
