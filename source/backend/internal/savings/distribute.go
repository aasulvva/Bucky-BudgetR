package savings

import (
	"cmp"
	"slices"

	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// Rule is a distributor rule as Split uses it: where a target's position is
// From or more and below To (nil: no end), it takes shares by Priority.
type Rule struct {
	From     decimal.Decimal
	To       *decimal.Decimal
	Priority int
	// PastGoal lets the rule take the target past its goal.
	PastGoal bool
}

// Candidate is a target the distributor may give to.
type Candidate struct {
	ID string
	// Position is where the target stands: its balance or TF (not below 0)
	// plus what's held for it.
	Position decimal.Decimal
	Goal     decimal.Decimal
	// Capacity is a bucket target's fixed BC, which no rule passes; nil for
	// none.
	Capacity *decimal.Decimal
	Rules    []Rule
}

// precision is the scale shares are worked out at, as the allocation
// routine's; epsilon is how close to an edge counts as there.
const precision = 16

var epsilon = decimal.New(1, -9)

// Split divides amount among the candidates by their rules (spec §8, #232).
// In steps: each candidate with a rule for its position, a priority above 0
// and room below its limit (the rule's edge, its goal unless the rule goes
// past it, and its capacity) gets amount × priority / Σ priorities, but only
// until the first candidate reaches its limit; then what's left is split
// again with the rules that apply from there. It stops when everything is
// placed or no candidate takes more. The shares are rounded down to cents,
// and the leftover cents go one each to the largest remainders, so they add
// up to what's placed; left is what no candidate took.
func Split(amount decimal.Decimal, cands []Candidate) (shares map[string]decimal.Decimal, left decimal.Decimal) {
	pos := make([]decimal.Decimal, len(cands))
	exact := make([]decimal.Decimal, len(cands))
	for i, c := range cands {
		pos[i] = c.Position
		exact[i] = decimal.Zero
	}
	remaining := amount

	// Each step brings at least one candidate to a limit, which moves it to
	// its next rule or stops it, so the steps are at most the rules and the
	// candidates; the guard is for safety only.
	for guard := 0; remaining.GreaterThan(epsilon) && guard < 10_000; guard++ {
		type active struct {
			i        int
			priority decimal.Decimal
			room     *decimal.Decimal // nil: no limit
		}
		var open []active
		weights := decimal.Zero
		for i, c := range cands {
			r, ok := ruleAt(c.Rules, pos[i])
			if !ok || r.Priority <= 0 {
				continue
			}
			limit := limitOf(c, r)
			if limit != nil && limit.Sub(pos[i]).LessThanOrEqual(epsilon) {
				continue
			}
			a := active{i: i, priority: decimal.NewFromInt(int64(r.Priority))}
			if limit != nil {
				room := limit.Sub(pos[i])
				a.room = &room
			}
			open = append(open, a)
			weights = weights.Add(a.priority)
		}
		if len(open) == 0 {
			break
		}
		// The step: what's left, or less if a candidate's share would take
		// it past its limit first.
		step := remaining
		for _, a := range open {
			if a.room == nil {
				continue
			}
			if need := a.room.Mul(weights).DivRound(a.priority, precision); need.LessThan(step) {
				step = need
			}
		}
		given := decimal.Zero
		for _, a := range open {
			share := step.Mul(a.priority).DivRound(weights, precision)
			// A candidate this step brings to its limit gets exactly its
			// room, so it's there and not a hair short.
			if a.room != nil && a.room.Sub(share).LessThanOrEqual(epsilon) {
				share = *a.room
			}
			exact[a.i] = exact[a.i].Add(share)
			pos[a.i] = pos[a.i].Add(share)
			given = given.Add(share)
		}
		remaining = remaining.Sub(given)
	}

	return roundShares(amount, cands, exact)
}

// ruleAt is the rule whose range holds pos.
func ruleAt(rules []Rule, pos decimal.Decimal) (Rule, bool) {
	for _, r := range rules {
		if pos.GreaterThanOrEqual(r.From) && (r.To == nil || pos.LessThan(*r.To)) {
			return r, true
		}
	}
	return Rule{}, false
}

// limitOf is how far the rule takes the candidate: its edge, the goal unless
// the rule goes past it, and the capacity, whichever comes first; nil for no
// limit.
func limitOf(c Candidate, r Rule) *decimal.Decimal {
	var limit *decimal.Decimal
	lower := func(d decimal.Decimal) {
		if limit == nil || d.LessThan(*limit) {
			limit = &d
		}
	}
	if r.To != nil {
		lower(*r.To)
	}
	if ceil := hardCap(c, r); ceil != nil {
		lower(*ceil)
	}
	return limit
}

// hardCap is what the candidate can't pass under the rule: its goal (unless
// the rule goes past it) and its capacity. Both are in cents.
func hardCap(c Candidate, r Rule) *decimal.Decimal {
	var ceil *decimal.Decimal
	if !r.PastGoal {
		g := c.Goal
		ceil = &g
	}
	if c.Capacity != nil && (ceil == nil || c.Capacity.LessThan(*ceil)) {
		b := *c.Capacity
		ceil = &b
	}
	return ceil
}

// roundShares rounds the exact shares to cents (spec §7: down, then a cent
// each to the largest remainders, ties to the larger share and then the
// lower ID), never past a candidate's capacity or goal.
func roundShares(amount decimal.Decimal, cands []Candidate, exact []decimal.Decimal) (map[string]decimal.Decimal, decimal.Decimal) {
	total := decimal.Zero
	for _, e := range exact {
		total = total.Add(e)
	}
	placed := total.Add(epsilon).RoundFloor(money.Places)
	if placed.GreaterThan(amount) {
		placed = amount
	}

	type part struct {
		i         int
		remainder decimal.Decimal
	}
	shares := map[string]decimal.Decimal{}
	floors := make([]decimal.Decimal, len(cands))
	parts := make([]part, 0, len(cands))
	given := decimal.Zero
	for i, e := range exact {
		floors[i] = e.Add(epsilon).RoundFloor(money.Places)
		if floors[i].GreaterThan(e) {
			floors[i] = e.RoundFloor(money.Places)
		}
		if floors[i].IsNegative() {
			floors[i] = decimal.Zero
		}
		given = given.Add(floors[i])
		if r := e.Sub(floors[i]); r.IsPositive() {
			parts = append(parts, part{i, r})
		}
	}
	slices.SortFunc(parts, func(x, y part) int {
		return cmp.Or(y.remainder.Cmp(x.remainder), exact[y.i].Cmp(exact[x.i]), cmp.Compare(cands[x.i].ID, cands[y.i].ID))
	})
	for _, p := range parts {
		if placed.Sub(given).LessThan(cent) {
			break
		}
		c := cands[p.i]
		if room := roomUnderCaps(c); room != nil && floors[p.i].Add(cent).GreaterThan(*room) {
			continue
		}
		floors[p.i] = floors[p.i].Add(cent)
		given = given.Add(cent)
	}
	for i, c := range cands {
		if floors[i].IsPositive() {
			shares[c.ID] = floors[i]
		}
	}
	return shares, amount.Sub(given)
}

// roomUnderCaps is the most any rule can give the candidate from where it
// stood: up to its capacity, or its goal when no rule goes past it.
func roomUnderCaps(c Candidate) *decimal.Decimal {
	var ceil *decimal.Decimal
	pastGoal := slices.ContainsFunc(c.Rules, func(r Rule) bool { return r.PastGoal })
	if !pastGoal {
		g := c.Goal
		ceil = &g
	}
	if c.Capacity != nil && (ceil == nil || c.Capacity.LessThan(*ceil)) {
		b := *c.Capacity
		ceil = &b
	}
	if ceil == nil {
		return nil
	}
	room := ceil.Sub(c.Position)
	return &room
}

var cent = decimal.New(1, -money.Places)
