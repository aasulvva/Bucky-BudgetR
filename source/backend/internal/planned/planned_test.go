package planned

import (
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

func TestCycleOf(t *testing.T) {
	day := func(m time.Month, d int) time.Time { return time.Date(2027, m, d, 0, 0, 0, 0, time.UTC) }
	jan := sqlc.Cycle{ID: "jan", StartAt: day(1, 1), EndAt: day(2, 1), State: sqlc.CycleStateFinished}
	feb := sqlc.Cycle{ID: "feb", StartAt: day(2, 1), EndAt: day(3, 1), State: sqlc.CycleStateActive}
	// A gap in April, then May.
	mar := sqlc.Cycle{ID: "mar", StartAt: day(3, 1), EndAt: day(4, 1), State: sqlc.CycleStateFuture}
	may := sqlc.Cycle{ID: "may", StartAt: day(5, 1), EndAt: day(6, 1), State: sqlc.CycleStateFuture}
	all := []sqlc.Cycle{jan, feb, mar, may}
	for _, c := range []struct {
		what string
		at   time.Time
		in   []sqlc.Cycle
		want string
	}{
		{"in the active cycle", day(2, 10), all, "feb"},
		{"at a cycle's start", day(3, 1), all, "mar"},
		{"in a later cycle", day(5, 20), all, "may"},
		{"delayed past its finished cycle", day(1, 20), all, "feb"},
		{"before any cycle", day(1, 1).AddDate(0, -1, 0), all, "feb"},
		{"in a gap after the active cycle", day(4, 10), all, ""},
		{"after the last cycle", day(7, 1), all, ""},
		{"no active cycle: its own finished one", day(1, 20), []sqlc.Cycle{jan, mar}, "jan"},
	} {
		if got := CycleOf(c.at, c.in); got != c.want {
			t.Errorf("%s: %q, want %q", c.what, got, c.want)
		}
	}
}
