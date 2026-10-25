package ids_test

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
)

const draws = 2000

func TestGenerators(t *testing.T) {
	user, account := ids.NewUser(), ids.NewAccount()
	bucket := ids.NewBucket(user)

	for _, tc := range []struct {
		kind   ids.Kind
		gen    func() string
		prefix string
		space  float64 // number of possible IDs for one prefix
	}{
		{ids.User, ids.NewUser, "", 9e5},
		{ids.Account, ids.NewAccount, "", 9e3},
		{ids.Cycle, func() string { return ids.NewCycle(user) }, user, 1e6},
		{ids.Bucket, func() string { return ids.NewBucket(user) }, user, 1e4},
		{ids.Transaction, func() string { return ids.NewTransaction(time.Now()) }, "", 1e8},
		{ids.BankLine, func() string { return ids.NewBankLine(account) }, account, 1e12},
		{ids.BucketLine, func() string { return ids.NewBucketLine(bucket) }, bucket, 1e14},
	} {
		t.Run(tc.kind.Name, func(t *testing.T) {
			seen := make(map[string]bool, draws)
			// Every digit should turn up right after the prefix.
			nextDigits := make(map[byte]bool)
			for range draws {
				id := tc.gen()
				if len(id) != tc.kind.Len || !tc.kind.Valid(id) {
					t.Fatalf("invalid %s ID %q", tc.kind.Name, id)
				}
				if !strings.HasPrefix(id, tc.prefix) {
					t.Fatalf("%q lacks prefix %q", id, tc.prefix)
				}
				seen[id] = true
				if tc.prefix != "" {
					nextDigits[id[len(tc.prefix)]] = true
				}
			}
			// Uniform draws from the space give this many distinct IDs on
			// average (small spaces like 9,000 accounts do collide).
			expected := tc.space * (1 - math.Exp(-draws/tc.space))
			if float64(len(seen)) < 0.95*expected {
				t.Errorf("only %d distinct IDs in %d draws, expected about %.0f", len(seen), draws, expected)
			}
			if tc.prefix != "" && len(nextDigits) != 10 {
				t.Errorf("random part is not uniform: first digits seen %v", nextDigits)
			}
		})
	}
}

func TestRanges(t *testing.T) {
	firstDigits := make(map[byte]bool)
	for range draws {
		u, a := ids.NewUser(), ids.NewAccount()
		if u < "100000" || u > "999999" || a < "1000" || a > "9999" {
			t.Fatalf("out of range: user %q, account %q", u, a)
		}
		firstDigits[u[0]] = true
	}
	if len(firstDigits) != 9 {
		t.Errorf("user IDs should start with every digit 1–9, saw %v", firstDigits)
	}
}

func TestTransactionDateIsUTC(t *testing.T) {
	// 00:30 on 26 Oct in Oslo (UTC+1) is still 25 Oct in UTC.
	oslo := time.FixedZone("CET", 3600)
	id := ids.NewTransaction(time.Date(2026, 10, 26, 0, 30, 0, 0, oslo))
	if !strings.HasPrefix(id, "20261025") {
		t.Errorf("got %q, want the UTC date 20261025", id)
	}
}

func TestValid(t *testing.T) {
	for _, tc := range []struct {
		kind ids.Kind
		id   string
		want bool
	}{
		{ids.User, "123456", true},
		{ids.User, "012345", false},
		{ids.User, "12345", false},
		{ids.User, "1234567", false},
		{ids.User, "12345a", false},
		{ids.User, " 123456", false},
		{ids.Account, "1000", true},
		{ids.Account, "0999", false},
		{ids.Transaction, "2026102512345678", true},
		{ids.Transaction, "2026133112345678", false}, // month 13
		{ids.Transaction, "2026022912345678", false}, // not a leap year
		{ids.BucketLine, "123456789012345678901234", true},
		{ids.BucketLine, "12345678901234567890123", false},
	} {
		if got := tc.kind.Valid(tc.id); got != tc.want {
			t.Errorf("%s.Valid(%q) = %v, want %v", tc.kind.Name, tc.id, got, tc.want)
		}
	}
}

func TestBadPrefixPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("NewCycle with a malformed user ID did not panic")
		}
	}()
	ids.NewCycle("12")
}
