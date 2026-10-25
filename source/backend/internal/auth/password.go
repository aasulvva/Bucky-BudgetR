package auth

import (
	"errors"
	"fmt"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

// bcryptCost is the work factor for new password hashes. Tests lower it.
var bcryptCost = 12

const (
	MinPasswordBytes = 12
	// MaxPasswordBytes is bcrypt's input limit; longer passwords would be
	// silently truncated, so they are rejected instead.
	MaxPasswordBytes = 72
)

// ErrWeakPassword means a new password doesn't meet the policy. The wrapped
// message says why and is safe to show.
var ErrWeakPassword = errors.New("weak password")

// ValidateNewPassword checks a new password against the policy.
func ValidateNewPassword(password, current string) error {
	switch {
	case len(password) < MinPasswordBytes:
		return fmt.Errorf("%w: use at least %d characters", ErrWeakPassword, MinPasswordBytes)
	case len(password) > MaxPasswordBytes:
		return fmt.Errorf("%w: use at most %d bytes", ErrWeakPassword, MaxPasswordBytes)
	case password == current:
		return fmt.Errorf("%w: the new password must differ from the current one", ErrWeakPassword)
	}
	return nil
}

// HashPassword returns a bcrypt hash of password.
func HashPassword(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(h), nil
}

// CheckPassword reports whether password matches hash.
func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// dummyHash is compared against when a username doesn't exist, so a failed
// login takes as long either way and doesn't reveal which usernames exist.
var dummyHash = sync.OnceValue(func() string {
	h, err := HashPassword("not a real password, only for timing")
	if err != nil {
		panic(err)
	}
	return h
})
