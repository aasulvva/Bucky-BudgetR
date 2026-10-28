package calendar

import (
	"testing"
	"time"
)

func date(t *testing.T, s string) Date {
	t.Helper()
	d, err := ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestEaster(t *testing.T) {
	for year, want := range map[int]string{
		2024: "2024-03-31", 2025: "2025-04-20", 2026: "2026-04-05", 2027: "2027-03-28",
		2028: "2028-04-16", 2029: "2029-04-01", 2030: "2030-04-21",
	} {
		if got := Easter(year).String(); got != want {
			t.Errorf("Easter %d = %s, want %s", year, got, want)
		}
	}
}

func TestNorwegian(t *testing.T) {
	for s, want := range map[string]bool{
		"2026-01-01": true, "2026-04-02": true, "2026-04-03": true, "2026-04-06": true, // Maundy Thursday, Good Friday, Easter Monday
		"2026-05-01": true, "2026-05-14": true, "2026-05-17": true, "2026-05-25": true, // Ascension Day, Whit Monday
		"2026-12-24": true, "2026-12-25": true, "2026-12-26": true, "2026-12-31": true,
		"2026-04-01": false, "2026-04-07": false, "2026-05-18": false, "2026-12-23": false,
	} {
		if got := norwegian(date(t, s)); got != want {
			t.Errorf("%s: %v, want %v", s, got, want)
		}
	}
}

func TestStart(t *testing.T) {
	payday := Rule{Day: 25, Shift: Previous, Holidays: Norway}
	tests := []struct {
		name  string
		rule  Rule
		year  int
		month time.Month
		want  string
	}{
		{"a working day", payday, 2026, time.November, "2026-11-25"},
		{"a Sunday", payday, 2026, time.October, "2026-10-23"},
		{"a Saturday", payday, 2026, time.July, "2026-07-24"},
		{"Christmas", payday, 2026, time.December, "2026-12-23"},
		{"Whit Monday", payday, 2026, time.May, "2026-05-22"},
		{"weekends only", Rule{Day: 25, Shift: Previous, Holidays: NoHolidays}, 2026, time.December, "2026-12-25"},
		{"not moved", Rule{Day: 25, Shift: None, Holidays: Norway}, 2026, time.October, "2026-10-25"},
		{"the next working day", Rule{Day: 25, Shift: Next, Holidays: Norway}, 2026, time.December, "2026-12-28"},
		{"into the next month", Rule{Day: 31, Shift: Next, Holidays: Norway}, 2026, time.October, "2026-11-02"},
		{"into the month before", Rule{Day: 1, Shift: Previous, Holidays: Norway}, 2027, time.January, "2026-12-30"},
		{"the 31st of a short month", Rule{Day: 31, Shift: None}, 2026, time.November, "2026-11-30"},
		{"the 31st of February", Rule{Day: 31, Shift: None}, 2028, time.February, "2028-02-29"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.rule.Start(tt.year, tt.month).String(); got != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestPeriods(t *testing.T) {
	payday := Rule{Day: 25, Shift: Previous, Holidays: Norway}
	want := []string{
		"2026-10-23 2026-11-24",
		"2026-11-25 2026-12-22",
		"2026-12-23 2027-01-24",
	}
	for _, from := range []string{"2026-10-23", "2026-10-28", "2026-11-24"} {
		got := payday.Periods(date(t, from), 3)
		for i, p := range got {
			if s := p.Start.String() + " " + p.End.String(); s != want[i] {
				t.Errorf("from %s: period %d is %s, want %s", from, i, s, want[i])
			}
		}
	}
	// A month's date that moved into the month before.
	newYear := Rule{Day: 1, Shift: Previous, Holidays: Norway}
	if p := newYear.Periods(date(t, "2026-12-31"), 1)[0]; p.Start.String() != "2026-12-30" || p.End.String() != "2027-01-31" {
		t.Errorf("new year: %v", p)
	}
}
