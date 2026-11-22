// Package ids generates the random numeric IDs defined in the spec (§1–§5).
//
// IDs are strings of digits with a fixed length per kind. Composite IDs start
// with their owner's ID, so the owner can be read from the ID itself:
//
//	User         6 digits             100000–999999
//	Account      4 digits             1000–9999
//	Cycle        User + 6 random      12 digits
//	Bucket       User + 4 random      10 digits
//	Transaction  YYYYMMDD + 8 random  16 digits (date in UTC)
//	BankLine     Account + 12 random  16 digits
//	BucketLine   Bucket + 14 random   24 digits
//	Schedule     User + 4 random      10 digits
//	Occurrence   Schedule + 8 random  18 digits
//	SavingsHolder User + 4 random     10 digits
//	SavingsLine  SavingsHolder + 14 random  24 digits
//	SavingsRule  SavingsHolder + 2 random   12 digits
//
// The database stores them as text with a CHECK on Kind.Pattern. They are
// drawn with crypto/rand; see Insert for handling collisions.
package ids

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"regexp"
	"time"
)

// Kind describes one ID format.
type Kind struct {
	Name string
	Len  int
	// Pattern is the anchored regular expression an ID of this kind matches.
	// Migrations use the same pattern in a CHECK constraint.
	Pattern string
	re      *regexp.Regexp
}

func newKind(name string, length int, pattern string) Kind {
	return Kind{Name: name, Len: length, Pattern: pattern, re: regexp.MustCompile(pattern)}
}

// The ID kinds. Owner-prefixed kinds start with a digit 1–9 because their
// owner's ID does.
var (
	User        = newKind("user", 6, `^[1-9][0-9]{5}$`)
	Account     = newKind("account", 4, `^[1-9][0-9]{3}$`)
	Cycle       = newKind("cycle", 12, `^[1-9][0-9]{11}$`)
	Bucket      = newKind("bucket", 10, `^[1-9][0-9]{9}$`)
	Transaction = newKind("transaction", 16, `^[0-9]{16}$`)
	BankLine    = newKind("bank line", 16, `^[1-9][0-9]{15}$`)
	BucketLine  = newKind("bucket line", 24, `^[1-9][0-9]{23}$`)
	Schedule    = newKind("schedule", 10, `^[1-9][0-9]{9}$`)
	Occurrence  = newKind("occurrence", 18, `^[1-9][0-9]{17}$`)
	// SavingsHolder is a savings target or a user's savings distributor.
	SavingsHolder = newKind("savings holder", 10, `^[1-9][0-9]{9}$`)
	SavingsLine   = newKind("savings line", 24, `^[1-9][0-9]{23}$`)
	// SavingsRule is a savings distributor rule, owned by its target.
	SavingsRule = newKind("savings rule", 12, `^[1-9][0-9]{11}$`)
)

// Valid reports whether s is a well-formed ID of this kind. For transactions
// it also checks that the first 8 digits are a real date.
func (k Kind) Valid(s string) bool {
	if !k.re.MatchString(s) {
		return false
	}
	if k.Name == Transaction.Name {
		_, err := time.Parse("20060102", s[:8])
		return err == nil
	}
	return true
}

// NewUser returns a random user ID.
func NewUser() string { return fmt.Sprint(100000 + randInt(900000)) }

// NewAccount returns a random bank account ID.
func NewAccount() string { return fmt.Sprint(1000 + randInt(9000)) }

// NewCycle returns a random ID for a cycle owned by userID.
func NewCycle(userID string) string { return withPrefix(User, userID, 6) }

// NewBucket returns a random ID for a bucket owned by userID.
func NewBucket(userID string) string { return withPrefix(User, userID, 4) }

// NewTransaction returns a random transaction header ID for the day of t in UTC.
func NewTransaction(t time.Time) string {
	return t.UTC().Format("20060102") + randDigits(8)
}

// NewBankLine returns a random ID for a bank transaction line of accountID.
func NewBankLine(accountID string) string { return withPrefix(Account, accountID, 12) }

// NewBucketLine returns a random ID for a bucket transaction line of bucketID.
func NewBucketLine(bucketID string) string { return withPrefix(Bucket, bucketID, 14) }

// NewSchedule returns a random ID for a schedule owned by userID.
func NewSchedule(userID string) string { return withPrefix(User, userID, 4) }

// NewOccurrence returns a random ID for an occurrence of scheduleID.
func NewOccurrence(scheduleID string) string { return withPrefix(Schedule, scheduleID, 8) }

// NewSavingsHolder returns a random ID for a savings target or distributor
// owned by userID.
func NewSavingsHolder(userID string) string { return withPrefix(User, userID, 4) }

// NewSavingsLine returns a random ID for a savings line of holderID.
func NewSavingsLine(holderID string) string { return withPrefix(SavingsHolder, holderID, 14) }

// NewSavingsRule returns a random ID for a distributor rule of targetID.
func NewSavingsRule(targetID string) string { return withPrefix(SavingsHolder, targetID, 2) }

// withPrefix appends n random digits to an owner ID. A malformed owner ID is
// a programming error, so it panics rather than returning an error.
func withPrefix(owner Kind, ownerID string, n int) string {
	if !owner.Valid(ownerID) {
		panic(fmt.Sprintf("ids: invalid %s ID %q as prefix", owner.Name, ownerID))
	}
	return ownerID + randDigits(n)
}

// randDigits returns n uniformly random digits, zero-padded.
func randDigits(n int) string {
	limit := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
	v, err := rand.Int(rand.Reader, limit)
	if err != nil {
		panic(fmt.Sprintf("ids: crypto/rand failed: %v", err))
	}
	return fmt.Sprintf("%0*s", n, v.String())
}

// randInt returns a uniformly random integer in [0, n).
func randInt(n int64) int64 {
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		panic(fmt.Sprintf("ids: crypto/rand failed: %v", err))
	}
	return v.Int64()
}
