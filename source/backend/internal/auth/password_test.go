package auth

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateNewPassword(t *testing.T) {
	for _, tc := range []struct {
		password, current string
		ok                bool
	}{
		{"correct horse battery", "", true},
		{strings.Repeat("a", MinPasswordBytes), "", true},
		{strings.Repeat("a", MinPasswordBytes-1), "", false},
		{strings.Repeat("a", MaxPasswordBytes), "", true},
		{strings.Repeat("a", MaxPasswordBytes+1), "", false},
		{strings.Repeat("æ", 37), "", false}, // 74 bytes in UTF-8
		{"same password here", "same password here", false},
	} {
		err := ValidateNewPassword(tc.password, tc.current)
		if (err == nil) != tc.ok || (err != nil && !errors.Is(err, ErrWeakPassword)) {
			t.Errorf("ValidateNewPassword(%q) = %v, want ok=%v", tc.password, err, tc.ok)
		}
	}
}

func TestHashAndCheck(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$2a$12$") {
		t.Errorf("hash %q is not bcrypt cost 12", h)
	}
	if !CheckPassword(h, "correct horse battery") || CheckPassword(h, "wrong horse battery") {
		t.Error("CheckPassword gave the wrong answer")
	}
}

func TestTokens(t *testing.T) {
	a, ha := newToken()
	b, _ := newToken()
	if a == b || len(a) != 43 || len(ha) != 32 {
		t.Fatalf("tokens %q, %q; hash length %d", a, b, len(ha))
	}
	if string(hashToken(a)) != string(ha) {
		t.Error("hashToken doesn't match the hash from newToken")
	}
}
