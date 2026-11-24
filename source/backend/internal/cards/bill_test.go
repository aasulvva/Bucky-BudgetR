package cards_test

import (
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
)

func date(s string) calendar.Date {
	d, err := calendar.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

// TestStatementDates: the latest statement day up to today, the next and
// previous ones, and the first due day after it (#262), with LastDay.
func TestStatementDates(t *testing.T) {
	for _, tc := range []struct {
		statementDay, dueDay int
		today                string
		statement, next, due string
	}{
		{1, 15, "2026-11-24", "2026-11-01", "2026-12-01", "2026-11-15"},
		{1, 15, "2026-11-01", "2026-11-01", "2026-12-01", "2026-11-15"},
		{20, 5, "2026-11-19", "2026-10-20", "2026-11-20", "2026-11-05"},
		{20, 5, "2026-11-20", "2026-11-20", "2026-12-20", "2026-12-05"},
		// The same day is due a month later.
		{10, 10, "2026-11-24", "2026-11-10", "2026-12-10", "2026-12-10"},
		// The last day of the month.
		{cards.LastDay, 15, "2026-03-10", "2026-02-28", "2026-03-31", "2026-03-15"},
		{cards.LastDay, 15, "2028-02-29", "2028-02-29", "2028-03-31", "2028-03-15"},
		{1, cards.LastDay, "2026-02-10", "2026-02-01", "2026-03-01", "2026-02-28"},
		{cards.LastDay, cards.LastDay, "2026-11-30", "2026-11-30", "2026-12-31", "2026-12-31"},
		// Across the year.
		{15, 1, "2027-01-03", "2026-12-15", "2027-01-15", "2027-01-01"},
	} {
		s := cards.StatementDate(tc.statementDay, date(tc.today))
		if s != date(tc.statement) {
			t.Errorf("day %d on %s: statement %s, want %s", tc.statementDay, tc.today, s, tc.statement)
		}
		if n := cards.NextStatementDate(tc.statementDay, s); n != date(tc.next) {
			t.Errorf("day %d on %s: next %s, want %s", tc.statementDay, tc.today, n, tc.next)
		}
		if p := cards.PreviousStatementDate(tc.statementDay, date(tc.next)); p != s {
			t.Errorf("day %d: previous of %s is %s, want %s", tc.statementDay, tc.next, p, s)
		}
		if d := cards.DueDate(s, tc.dueDay); d != date(tc.due) {
			t.Errorf("statement %s, due day %d: due %s, want %s", s, tc.dueDay, d, tc.due)
		}
	}
}
