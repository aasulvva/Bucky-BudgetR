package cycles_test

import (
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// payday is the 25th, or the working day before, in Oslo.
const payday = `{"time_zone": "Europe/Oslo", "cycle_rule": {"day": 25, "shift": "previous", "holidays": "NO", "ahead": 3}}`

func (e env) setPreferences(t *testing.T, prefs string) {
	t.Helper()
	if _, err := e.pool.Exec(t.Context(), `UPDATE users SET preferences = $2 WHERE id = $1`, e.user, prefs); err != nil {
		t.Fatal(err)
	}
}

// planned returns the user's future cycles as "start end" in UTC, with a *
// for the ones the rule planned.
func (e env) planned(t *testing.T) []string {
	t.Helper()
	list, err := e.svc.List(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, c := range list {
		if c.State != sqlc.CycleStateFuture {
			continue
		}
		s := c.StartAt.UTC().Format(time.RFC3339) + " " + c.EndAt.UTC().Format(time.RFC3339)
		if c.Generated {
			s += " *"
		}
		out = append(out, s)
	}
	return out
}

func checkPlanned(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("planned:\n%q\nwant:\n%q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("planned %d: %s, want %s", i, got[i], want[i])
		}
	}
}

// Oslo midnights of the rule's dates around now (15 September 2026).
const (
	aug25 = "2026-08-24T22:00:00Z"
	sep25 = "2026-09-24T22:00:00Z"
	oct23 = "2026-10-22T22:00:00Z" // the 25th is a Sunday
	nov25 = "2026-11-24T23:00:00Z"
	dec23 = "2026-12-22T23:00:00Z" // 24 and 25 December aren't bank days
)

func TestTopUp(t *testing.T) {
	t.Run("without a rule or a time zone", func(t *testing.T) {
		e := setup(t)
		if err := e.svc.TopUp(t.Context(), e.user); err != nil {
			t.Fatal(err)
		}
		e.setPreferences(t, `{"cycle_rule": {"day": 25, "shift": "previous", "holidays": "NO", "ahead": 3}}`)
		if err := e.svc.TopUp(t.Context(), e.user); err != nil {
			t.Fatal(err)
		}
		checkPlanned(t, e.planned(t))
	})

	t.Run("without cycles, from today's period", func(t *testing.T) {
		e := setup(t)
		e.setPreferences(t, payday)
		if err := e.svc.TopUp(t.Context(), e.user); err != nil {
			t.Fatal(err)
		}
		checkPlanned(t, e.planned(t), aug25+" "+sep25+" *", sep25+" "+oct23+" *", oct23+" "+nov25+" *")

		// Topped up already.
		if err := e.svc.TopUp(t.Context(), e.user); err != nil {
			t.Fatal(err)
		}
		if n := len(e.planned(t)); n != 3 {
			t.Errorf("%d planned after a second top-up", n)
		}
	})

	t.Run("after the user's cycle", func(t *testing.T) {
		e := setup(t)
		e.create(t, [2]time.Time{at(sep25), at(oct23)})
		e.setPreferences(t, payday)
		if err := e.svc.TopUp(t.Context(), e.user); err != nil {
			t.Fatal(err)
		}
		checkPlanned(t, e.planned(t), sep25+" "+oct23, oct23+" "+nov25+" *", nov25+" "+dec23+" *")
	})

	t.Run("on a rule date after a gap", func(t *testing.T) {
		e := setup(t)
		e.create(t, [2]time.Time{at(sep25), at("2026-10-19T22:00:00Z")}) // to 20 October
		e.setPreferences(t, payday)
		if err := e.svc.TopUp(t.Context(), e.user); err != nil {
			t.Fatal(err)
		}
		checkPlanned(t, e.planned(t), sep25+" 2026-10-19T22:00:00Z", oct23+" "+nov25+" *", nov25+" "+dec23+" *")
	})
}

func TestReplan(t *testing.T) {
	e := setup(t)
	e.setPreferences(t, payday)
	if err := e.svc.TopUp(t.Context(), e.user); err != nil {
		t.Fatal(err)
	}
	// Move the last one by hand: it's the user's now.
	list, err := e.svc.List(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	end := at("2026-11-30T23:00:00Z")
	if _, err := e.svc.Update(t.Context(), e.user, list[2].ID, cycles.Changes{EndAt: &end}); err != nil {
		t.Fatal(err)
	}

	// The 1st of the month. The first cycle began on 25 August, so it
	// stays; the second is replaced by one after the user's.
	e.setPreferences(t, `{"time_zone": "Europe/Oslo", "cycle_rule": {"day": 1, "shift": "none", "holidays": "none", "ahead": 3}}`)
	if err := e.svc.Replan(t.Context(), e.user); err != nil {
		t.Fatal(err)
	}
	checkPlanned(t, e.planned(t),
		aug25+" "+sep25+" *",
		oct23+" 2026-11-30T23:00:00Z",
		"2026-11-30T23:00:00Z 2026-12-31T23:00:00Z *",
	)

	// Without a rule, the planned cycles stay.
	e.setPreferences(t, `{"time_zone": "Europe/Oslo"}`)
	if err := e.svc.Replan(t.Context(), e.user); err != nil {
		t.Fatal(err)
	}
	if n := len(e.planned(t)); n != 3 {
		t.Errorf("%d planned without a rule", n)
	}
}

func TestStartAndEndTopUp(t *testing.T) {
	e := setup(t)
	e.setPreferences(t, payday)
	if err := e.svc.TopUp(t.Context(), e.user); err != nil {
		t.Fatal(err)
	}
	list, err := e.svc.List(t.Context(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Start(t.Context(), e.user, list[0].ID); err != nil {
		t.Fatal(err)
	}
	checkPlanned(t, e.planned(t), sep25+" "+oct23+" *", oct23+" "+nov25+" *", nov25+" "+dec23+" *")

	*e.now = at("2026-09-25T08:00:00Z")
	ended, err := e.svc.End(t.Context(), e.user, list[0].ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if ended.Started == nil || !ended.Started.StartAt.Equal(at(sep25)) {
		t.Fatalf("started %+v", ended.Started)
	}
	checkPlanned(t, e.planned(t), oct23+" "+nov25+" *", nov25+" "+dec23+" *", dec23+" 2027-01-24T23:00:00Z *")
}

func TestPeriods(t *testing.T) {
	e := setup(t)
	rule := cycles.Rule{Day: 25, Shift: "previous", Holidays: "NO", Ahead: 3}
	// Without a time zone, today is in UTC.
	got, err := e.svc.Periods(t.Context(), e.user, rule, nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Start.String() != "2026-08-25" || got[1].End.String() != "2026-10-22" {
		t.Errorf("periods %v", got)
	}
}
