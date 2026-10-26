// Package allocation is the Money Allocation Routine (spec §7): it works out
// how much of each source account's money backs each of its buckets, the
// Current Available Funds (CAF).
//
// Allocate is the pure calculation. Run applies it to the database, and only
// when one of the §7 triggers says so (Follow, Needed), so money isn't
// reshuffled on every transaction.
package allocation

import (
	"cmp"
	"slices"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Bucket is what the routine needs to know about a bucket.
type Bucket struct {
	ID string
	// TF is the bucket's Target Funds. Buckets with TF ≤ 0 get no CAF.
	TF         decimal.Decimal
	Priority   bool
	Importance int
	// CAF is the stored CAF. Allocate ignores it; the others use it.
	CAF decimal.Decimal
}

var cent = decimal.New(1, -money.Places)

// Allocate splits available among buckets and returns each bucket's CAF:
//
//   - If available covers every TF, CAF = TF.
//   - Otherwise priority buckets are funded first, then the rest. Within a
//     group, money is split by weight TF × importance, no bucket gets more
//     than its TF, and what a capped bucket can't take is split again among
//     the others.
//
// Amounts are rounded down to cents and the leftover cents go, one each, to
// the buckets with the largest remainders, so the CAFs add up to exactly what
// was split. A negative available counts as 0.
func Allocate(available decimal.Decimal, buckets []Bucket) map[string]decimal.Decimal {
	out := make(map[string]decimal.Decimal, len(buckets))
	var prio, rest []Bucket
	for _, b := range buckets {
		out[b.ID] = decimal.Zero
		switch {
		case !b.TF.IsPositive():
		case b.Priority:
			prio = append(prio, b)
		default:
			rest = append(rest, b)
		}
	}
	left := decimal.Max(available, decimal.Zero)
	for _, group := range [][]Bucket{prio, rest} {
		if total := sumTF(group); left.GreaterThanOrEqual(total) {
			for _, b := range group {
				out[b.ID] = b.TF
			}
			left = left.Sub(total)
			continue
		}
		for id, caf := range split(left, group) {
			out[id] = caf
		}
		break // nothing is left for the next group
	}
	return out
}

// split divides amount (less than the group's total TF) by weight, capping
// each bucket at its TF.
func split(amount decimal.Decimal, group []Bucket) map[string]decimal.Decimal {
	out := map[string]decimal.Decimal{}
	open := slices.Clone(group)
	for {
		var weights decimal.Decimal
		for _, b := range open {
			weights = weights.Add(weight(b))
		}
		// Buckets whose share would reach their TF get their TF; the rest is
		// split again among the others.
		var capped []Bucket
		for _, b := range open {
			if share(amount, b, weights).GreaterThanOrEqual(b.TF) {
				capped = append(capped, b)
			}
		}
		if len(capped) == 0 {
			break
		}
		for _, b := range capped {
			out[b.ID] = b.TF
			amount = amount.Sub(b.TF)
		}
		open = slices.DeleteFunc(open, func(b Bucket) bool {
			return slices.ContainsFunc(capped, func(c Bucket) bool { return c.ID == b.ID })
		})
		if len(open) == 0 {
			break
		}
	}

	// Round down, then hand out the leftover cents by largest remainder
	// (ties: larger weight, then ID). An uncapped share is below its TF, so
	// one more cent never takes it above.
	var weights decimal.Decimal
	for _, b := range open {
		weights = weights.Add(weight(b))
	}
	type part struct {
		b         Bucket
		remainder decimal.Decimal
	}
	parts := make([]part, len(open))
	given := decimal.Zero
	for i, b := range open {
		s := share(amount, b, weights)
		floor := s.RoundFloor(money.Places)
		out[b.ID] = floor
		given = given.Add(floor)
		parts[i] = part{b, s.Sub(floor)}
	}
	slices.SortFunc(parts, func(x, y part) int {
		return cmp.Or(y.remainder.Cmp(x.remainder), weight(y.b).Cmp(weight(x.b)), cmp.Compare(x.b.ID, y.b.ID))
	})
	for i := 0; amount.Sub(given).GreaterThanOrEqual(cent) && i < len(parts); i++ {
		id := parts[i].b.ID
		out[id] = out[id].Add(cent)
		given = given.Add(cent)
	}
	return out
}

func weight(b Bucket) decimal.Decimal { return b.TF.Mul(decimal.NewFromInt(int64(b.Importance))) }

// share is b's part of amount at full precision.
func share(amount decimal.Decimal, b Bucket, weights decimal.Decimal) decimal.Decimal {
	if weights.IsZero() {
		return decimal.Zero
	}
	return amount.Mul(weight(b)).DivRound(weights, 16)
}

func sumTF(buckets []Bucket) decimal.Decimal {
	total := decimal.Zero
	for _, b := range buckets {
		total = total.Add(b.TF)
	}
	return total
}

// Clamp returns the stored CAF limited to 0 ≤ CAF ≤ max(TF, 0).
func Clamp(b Bucket) decimal.Decimal {
	return decimal.Min(decimal.Max(b.CAF, decimal.Zero), decimal.Max(b.TF, decimal.Zero))
}

// Needed reports whether the stored (clamped) CAF no longer fits the account,
// whatever changed it (spec §7): when it's more than the available funds, or
// when the funds cover every TF but CAF doesn't match it.
func Needed(available decimal.Decimal, buckets []Bucket) bool {
	available = decimal.Max(available, decimal.Zero)
	caf, tf := decimal.Zero, decimal.Zero
	for _, b := range buckets {
		caf = caf.Add(Clamp(b))
		tf = tf.Add(decimal.Max(b.TF, decimal.Zero))
	}
	switch {
	case caf.GreaterThan(available):
		return true
	case available.GreaterThanOrEqual(tf):
		return !caf.Equal(tf)
	default:
		return false
	}
}

// Lines is what one transaction did to a source account: the sum of its bank
// lines there, and its lines on the account's buckets.
type Lines struct {
	// Banked is set when the transaction has a bank line on the account (an
	// income, expense or transfer, not a bucket-only REF, OVF and so on).
	Banked  bool
	Bank    decimal.Decimal
	Buckets map[string]decimal.Decimal
}

// Follow applies a transaction to the CAF of an account's buckets, which hold
// the TF after it and the CAF before it, and reports whether it calls for a
// recalculation (spec §7). available is the balance after it.
//
// With a bank line, each bucket line moves its own bucket's CAF: an expense
// of 50 from a bucket takes 50 of its CAF, so the other buckets keep theirs.
// A recalculation is due when:
//
//   - part of the bank line isn't on a bucket: money no bucket owns came in
//     or went out;
//   - a bucket's CAF is spent (0 or below), or an income into an overspent
//     bucket left it above TF;
//   - the balance crossed Σ TF, up or down.
//
// Without a bank line, a move of TF between the account's buckets (a BAT
// within one account) takes CAF along: see moveAlong.
func Follow(available decimal.Decimal, buckets []Bucket, l Lines) bool {
	untied := l.Bank
	due := false
	tfBefore, tfAfter := decimal.Zero, decimal.Zero
	for i, b := range buckets {
		d := l.Buckets[b.ID]
		tfBefore = tfBefore.Add(decimal.Max(b.TF.Sub(d), decimal.Zero))
		tfAfter = tfAfter.Add(decimal.Max(b.TF, decimal.Zero))
		if !l.Banked || d.IsZero() {
			continue
		}
		untied = untied.Sub(d)
		caf := b.CAF.Add(d)
		if d.IsNegative() && !caf.IsPositive() || caf.GreaterThan(decimal.Max(b.TF, decimal.Zero)) {
			due = true
		}
		buckets[i].CAF = caf
	}
	if l.Banked && !untied.IsZero() {
		due = true
	}
	if !l.Banked {
		moveAlong(buckets, l.Buckets)
	}
	before := decimal.Max(available.Sub(l.Bank), decimal.Zero).GreaterThanOrEqual(tfBefore)
	after := decimal.Max(available, decimal.Zero).GreaterThanOrEqual(tfAfter)
	return due || before != after
}

// moveAlong moves CAF with TF when a bucket-only transaction moves TF between
// the account's buckets, its lines on them adding up to 0 (spec §7). Covered
// money moves first: a bucket that gives d hands over up to d of its CAF, so
// a gap it had stays with it. The buckets that receive take it up to their
// TF; what they can't take goes back to the givers, up to theirs. The buckets
// hold the TF after the transaction and the CAF before it.
func moveAlong(buckets []Bucket, lines map[string]decimal.Decimal) {
	sum, n := decimal.Zero, 0
	for _, b := range buckets {
		if d := lines[b.ID]; !d.IsZero() {
			sum = sum.Add(d)
			n++
		}
	}
	if n < 2 || !sum.IsZero() {
		return
	}
	room := func(b Bucket) decimal.Decimal {
		return decimal.Max(decimal.Max(b.TF, decimal.Zero).Sub(b.CAF), decimal.Zero)
	}
	moving := decimal.Zero
	for i, b := range buckets {
		if d := lines[b.ID]; d.IsNegative() {
			give := decimal.Min(d.Neg(), decimal.Max(b.CAF, decimal.Zero))
			moving = moving.Add(give)
			buckets[i].CAF = b.CAF.Sub(give)
		}
	}
	for _, receiving := range []bool{true, false} {
		for i, b := range buckets {
			if lines[b.ID].IsPositive() != receiving || lines[b.ID].IsZero() || !moving.IsPositive() {
				continue
			}
			add := decimal.Min(moving, room(b))
			buckets[i].CAF = b.CAF.Add(add)
			moving = moving.Sub(add)
		}
	}
}
