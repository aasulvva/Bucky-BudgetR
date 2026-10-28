// Package calendar computes the dates of a cycle rule (#72): a day of the
// month, moved off weekends and holidays, as salaries are paid.
package calendar

import (
	"fmt"
	"time"
)

// Date is a calendar date, without a time or a zone.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// DateOf returns the date t falls on, in t's location.
func DateOf(t time.Time) Date {
	y, m, d := t.Date()
	return Date{y, m, d}
}

// ParseDate parses "YYYY-MM-DD".
func ParseDate(s string) (Date, error) {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		return Date{}, fmt.Errorf("parse date: %w", err)
	}
	return DateOf(t), nil
}

func (d Date) String() string { return fmt.Sprintf("%04d-%02d-%02d", d.Year, d.Month, d.Day) }

// Time returns the date's midnight in loc.
func (d Date) Time(loc *time.Location) time.Time {
	return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, loc)
}

// AddDays returns the date n days later (earlier when n is negative).
func (d Date) AddDays(n int) Date { return DateOf(d.Time(time.UTC).AddDate(0, 0, n)) }

// Weekday returns the day of the week.
func (d Date) Weekday() time.Weekday { return d.Time(time.UTC).Weekday() }

// Before reports whether d is before e.
func (d Date) Before(e Date) bool { return d.Time(time.UTC).Before(e.Time(time.UTC)) }

// Shift says where a rule date that isn't a working day moves.
type Shift string

const (
	// Previous moves it to the working day before.
	Previous Shift = "previous"
	// Next moves it to the working day after.
	Next Shift = "next"
	// None keeps it.
	None Shift = "none"
)

// Holidays names a holiday calendar.
type Holidays string

const (
	// NoHolidays only skips weekends.
	NoHolidays Holidays = "none"
	// Norway skips Norwegian bank holidays: the public holidays, and
	// 24 and 31 December.
	Norway Holidays = "NO"
)

// Rule gives a cycle's start in each month: Day (1–31; a day the month
// doesn't have is its last day), moved by Shift when it isn't a working day.
type Rule struct {
	Day      int
	Shift    Shift
	Holidays Holidays
}

// Period is one cycle of a rule: from Start to End, its last day.
type Period struct {
	Start Date
	End   Date
}

// Start returns the rule's date in a month.
func (r Rule) Start(year int, month time.Month) Date {
	last := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
	d := Date{year, month, min(max(r.Day, 1), last)}
	step := 0
	switch r.Shift {
	case Previous:
		step = -1
	case Next:
		step = 1
	}
	for step != 0 && !r.Holidays.working(d) {
		d = d.AddDays(step)
	}
	return d
}

// Periods returns n periods in order, from the one that contains from.
func (r Rule) Periods(from Date, n int) []Period {
	// Months are counted from year 0. A month's date may move into the month
	// before or after, so start two months back.
	k := from.Year*12 + int(from.Month) - 1 - 2
	start := func(k int) Date { return r.Start(k/12, time.Month(k%12+1)) }
	for !from.Before(start(k + 1)) {
		k++
	}
	out := make([]Period, n)
	for i := range out {
		out[i] = Period{Start: start(k + i), End: start(k + i + 1).AddDays(-1)}
	}
	return out
}

// working reports whether d is a working day in the calendar.
func (h Holidays) working(d Date) bool {
	if wd := d.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return false
	}
	return h != Norway || !norwegian(d)
}

// norwegian reports whether d is a Norwegian bank holiday.
func norwegian(d Date) bool {
	switch {
	case d.Month == time.January && d.Day == 1,
		d.Month == time.May && (d.Day == 1 || d.Day == 17),
		d.Month == time.December && (d.Day == 24 || d.Day == 25 || d.Day == 26 || d.Day == 31):
		return true
	}
	easter := Easter(d.Year)
	for _, offset := range []int{-3, -2, 0, 1, 39, 49, 50} {
		if easter.AddDays(offset) == d {
			return true
		}
	}
	return false
}

// Easter returns Easter Sunday in the Gregorian calendar (the anonymous
// Gregorian computus).
func Easter(year int) Date {
	a := year % 19
	b, c := year/100, year%100
	d, e := b/4, b%4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i, k := c/4, c%4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 451
	month := (h + l - 7*m + 114) / 31
	day := (h+l-7*m+114)%31 + 1
	return Date{year, time.Month(month), day}
}
