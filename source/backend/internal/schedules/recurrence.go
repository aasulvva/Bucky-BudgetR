package schedules

import (
	"math"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// Rule is when a schedule's occurrences fall: the first on Start at Minute
// (minutes after midnight) in Location, then every Every days, weeks, months
// or years. Start, EndDate and the day of each occurrence are calendar dates
// (time.Time at UTC midnight, as sqlc reads a date).
type Rule struct {
	Start     time.Time
	Minute    int
	Location  *time.Location
	Frequency sqlc.ScheduleFrequency
	Every     int
	// EndCount ends it after this many occurrences (0: no limit), counted
	// from Start. EndDate ends it after the occurrence on that day (zero: no
	// end). At most one is set.
	EndCount int
	EndDate  time.Time
}

// maxIndex caps the occurrence numbers searched, so a rule without an end
// can't loop forever: daily for about 2,700 years.
const maxIndex = 1_000_000

// Occurrence returns the time of occurrence k (from 0), and false past the
// rule's end.
//
// Months and years keep Start's day, using the last day of shorter months, and
// count from Start, so the day doesn't drift (31 Jan, 28 Feb, 31 Mar). A wall
// time that doesn't exist on a day (in a DST gap) is moved by time.Date; one
// that exists twice gets one of the two.
func (r Rule) Occurrence(k int) (time.Time, bool) {
	if k < 0 || k > maxIndex || (r.Frequency == sqlc.ScheduleFrequencyOnce && k > 0) || (r.EndCount > 0 && k >= r.EndCount) {
		return time.Time{}, false
	}
	day := r.day(k)
	if !r.EndDate.IsZero() && day.After(r.EndDate) {
		return time.Time{}, false
	}
	return time.Date(day.Year(), day.Month(), day.Day(), r.Minute/60, r.Minute%60, 0, 0, r.Location), true
}

// day is the calendar date of occurrence k, at UTC midnight.
func (r Rule) day(k int) time.Time {
	y, m, d := r.Start.Date()
	n := k * r.Every
	switch r.Frequency {
	case sqlc.ScheduleFrequencyDay:
		return time.Date(y, m, d+n, 0, 0, 0, 0, time.UTC)
	case sqlc.ScheduleFrequencyWeek:
		return time.Date(y, m, d+7*n, 0, 0, 0, 0, time.UTC)
	case sqlc.ScheduleFrequencyMonth:
		return clamped(y, int(m)-1+n, d)
	case sqlc.ScheduleFrequencyYear:
		return clamped(y+n, int(m)-1, d)
	}
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// clamped is day d of month m (from 0, may run past 11) of year y, or the
// month's last day if it is shorter.
func clamped(y, m, d int) time.Time {
	first := time.Date(y, time.Month(m+1), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	return first.AddDate(0, 0, min(d, last)-1)
}

// NextAt returns the first occurrence at or after t: its number and time, or
// false if the rule ends before t.
func (r Rule) NextAt(t time.Time) (int, time.Time, bool) {
	k := r.estimate(t)
	// The estimate is a little early; step forward, then make sure the one
	// before it is before t.
	for {
		at, ok := r.Occurrence(k)
		if !ok {
			return 0, time.Time{}, false
		}
		if !at.Before(t) {
			break
		}
		k++
	}
	for k > 0 {
		at, _ := r.Occurrence(k - 1)
		if at.Before(t) {
			break
		}
		k--
	}
	at, _ := r.Occurrence(k)
	return k, at, true
}

// estimate is an occurrence number at or a few before the first at or after t.
func (r Rule) estimate(t time.Time) int {
	first, ok := r.Occurrence(0)
	if !ok || !t.After(first) || r.Frequency == sqlc.ScheduleFrequencyOnce {
		return 0
	}
	days := t.Sub(first).Hours() / 24
	unit := map[sqlc.ScheduleFrequency]float64{
		sqlc.ScheduleFrequencyDay: 1, sqlc.ScheduleFrequencyWeek: 7,
		// The average month and year: a clamped day is off by at most 3 days.
		sqlc.ScheduleFrequencyMonth: 365.2425 / 12, sqlc.ScheduleFrequencyYear: 365.2425,
	}[r.Frequency]
	k := int(math.Floor(days/(unit*float64(r.Every)))) - 1
	return min(max(k, 0), maxIndex)
}

// Upcoming returns the times of up to n occurrences at or after t.
func (r Rule) Upcoming(t time.Time, n int) []time.Time {
	out := []time.Time{}
	k, at, ok := r.NextAt(t)
	for ok && len(out) < n {
		out = append(out, at)
		k++
		at, ok = r.Occurrence(k)
	}
	return out
}
