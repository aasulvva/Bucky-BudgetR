package schedules

import (
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

func date(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func oslo(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Oslo")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// wall formats the occurrences as wall times in their location.
func wall(ts []time.Time) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.Format("2006-01-02 15:04 MST")
	}
	return out
}

func TestOccurrences(t *testing.T) {
	loc := oslo(t)
	for _, tc := range []struct {
		name string
		rule Rule
		want []string
	}{
		{"once", Rule{Start: date(2026, 11, 10), Minute: 8 * 60, Frequency: sqlc.ScheduleFrequencyOnce, Every: 1},
			[]string{"2026-11-10 08:00 CET"}},
		{"daily", Rule{Start: date(2026, 12, 30), Minute: 23*60 + 59, Frequency: sqlc.ScheduleFrequencyDay, Every: 1},
			[]string{"2026-12-30 23:59 CET", "2026-12-31 23:59 CET", "2027-01-01 23:59 CET", "2027-01-02 23:59 CET"}},
		{"every 2 weeks", Rule{Start: date(2026, 11, 2), Minute: 0, Frequency: sqlc.ScheduleFrequencyWeek, Every: 2},
			[]string{"2026-11-02 00:00 CET", "2026-11-16 00:00 CET", "2026-11-30 00:00 CET", "2026-12-14 00:00 CET"}},
		{"monthly from the 31st", Rule{Start: date(2027, 1, 31), Minute: 9 * 60, Frequency: sqlc.ScheduleFrequencyMonth, Every: 1},
			[]string{"2027-01-31 09:00 CET", "2027-02-28 09:00 CET", "2027-03-31 09:00 CEST", "2027-04-30 09:00 CEST"}},
		{"every 3 months", Rule{Start: date(2026, 11, 30), Minute: 12 * 60, Frequency: sqlc.ScheduleFrequencyMonth, Every: 3},
			[]string{"2026-11-30 12:00 CET", "2027-02-28 12:00 CET", "2027-05-30 12:00 CEST", "2027-08-30 12:00 CEST"}},
		{"yearly from 29 Feb", Rule{Start: date(2028, 2, 29), Minute: 6 * 60, Frequency: sqlc.ScheduleFrequencyYear, Every: 1},
			[]string{"2028-02-29 06:00 CET", "2029-02-28 06:00 CET", "2030-02-28 06:00 CET", "2031-02-28 06:00 CET", "2032-02-29 06:00 CET"}},
		{"after 3", Rule{Start: date(2026, 11, 1), Minute: 60, Frequency: sqlc.ScheduleFrequencyMonth, Every: 1, EndCount: 3},
			[]string{"2026-11-01 01:00 CET", "2026-12-01 01:00 CET", "2027-01-01 01:00 CET"}},
		{"until a date", Rule{Start: date(2026, 11, 1), Minute: 60, Frequency: sqlc.ScheduleFrequencyWeek, Every: 1, EndDate: date(2026, 11, 22)},
			[]string{"2026-11-01 01:00 CET", "2026-11-08 01:00 CET", "2026-11-15 01:00 CET", "2026-11-22 01:00 CET"}},
		// The clocks go forward at 02:00 on 28 March 2027 and back at 03:00
		// on 31 October: the wall time stays.
		{"across DST", Rule{Start: date(2027, 3, 27), Minute: 8 * 60, Frequency: sqlc.ScheduleFrequencyDay, Every: 1},
			[]string{"2027-03-27 08:00 CET", "2027-03-28 08:00 CEST", "2027-03-29 08:00 CEST"}},
		// 02:30 doesn't exist that day; time.Date moves it on by the hour.
		{"in the DST gap", Rule{Start: date(2027, 3, 27), Minute: 2*60 + 30, Frequency: sqlc.ScheduleFrequencyDay, Every: 1},
			[]string{"2027-03-27 02:30 CET", "2027-03-28 03:30 CEST", "2027-03-29 02:30 CEST"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.rule.Location = loc
			var got []time.Time
			for k := range len(tc.want) + 2 {
				at, ok := tc.rule.Occurrence(k)
				if !ok {
					break
				}
				got = append(got, at)
			}
			// Rules without an end give more; compare what was asked for.
			if tc.rule.EndCount == 0 && tc.rule.EndDate.IsZero() && tc.rule.Frequency != sqlc.ScheduleFrequencyOnce {
				got = got[:len(tc.want)]
			}
			if g, w := wall(got), tc.want; len(g) != len(w) || !equal(g, w) {
				t.Errorf("got %v, want %v", g, w)
			}
		})
	}
}

func equal(a, b []string) bool {
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return len(a) == len(b)
}

func TestNextAt(t *testing.T) {
	loc := oslo(t)
	monthly := Rule{Start: date(2026, 1, 31), Minute: 9 * 60, Location: loc, Frequency: sqlc.ScheduleFrequencyMonth, Every: 1}
	feb := time.Date(2026, 2, 28, 9, 0, 0, 0, loc)
	for _, tc := range []struct {
		name string
		rule Rule
		t    time.Time
		k    int
		want string // "" for none
	}{
		{"before the start", monthly, date(2025, 6, 1), 0, "2026-01-31 09:00 CET"},
		{"just before", monthly, feb.Add(-time.Second), 1, "2026-02-28 09:00 CET"},
		{"at", monthly, feb, 1, "2026-02-28 09:00 CET"},
		{"just after", monthly, feb.Add(time.Second), 2, "2026-03-31 09:00 CEST"},
		{"years later", monthly, time.Date(2126, 2, 1, 0, 0, 0, 0, loc), 1201, "2126-02-28 09:00 CET"},
		{"daily, years later", Rule{Start: date(2026, 1, 1), Minute: 0, Location: loc, Frequency: sqlc.ScheduleFrequencyDay, Every: 3},
			time.Date(2036, 1, 1, 12, 0, 0, 0, loc), 1218, "2036-01-03 00:00 CET"},
		{"once, passed", Rule{Start: date(2026, 1, 1), Location: loc, Frequency: sqlc.ScheduleFrequencyOnce, Every: 1},
			date(2026, 1, 2), 0, ""},
		{"ended", Rule{Start: date(2026, 1, 1), Location: loc, Frequency: sqlc.ScheduleFrequencyWeek, Every: 1, EndCount: 4},
			date(2026, 1, 23), 0, ""},
		{"last one", Rule{Start: date(2026, 1, 1), Location: loc, Frequency: sqlc.ScheduleFrequencyWeek, Every: 1, EndDate: date(2026, 1, 22)},
			date(2026, 1, 21), 3, "2026-01-22 00:00 CET"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			k, at, ok := tc.rule.NextAt(tc.t)
			if tc.want == "" {
				if ok {
					t.Errorf("got %d %v, want none", k, at)
				}
				return
			}
			if !ok || k != tc.k || at.Format("2006-01-02 15:04 MST") != tc.want {
				t.Errorf("got %d %v %v, want %d %s", k, at, ok, tc.k, tc.want)
			}
		})
	}
}

func TestUpcoming(t *testing.T) {
	r := Rule{Start: date(2026, 11, 1), Minute: 60, Location: time.UTC, Frequency: sqlc.ScheduleFrequencyWeek, Every: 1, EndCount: 3}
	if got := wall(r.Upcoming(date(2026, 11, 5), 5)); !equal(got, []string{"2026-11-08 01:00 UTC", "2026-11-15 01:00 UTC"}) {
		t.Errorf("upcoming %v", got)
	}
	if got := r.Upcoming(date(2027, 1, 1), 5); len(got) != 0 {
		t.Errorf("after the end %v", got)
	}
}
