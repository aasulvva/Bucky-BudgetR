package auth_test

import (
	"log/slog"
	"strings"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func TestEnsureInitialAdmin(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	var logs strings.Builder
	logger := slog.New(slog.NewTextHandler(&logs, nil))

	for range 2 { // the second run must not create another user
		if err := auth.EnsureInitialAdmin(ctx, pool, "", logger); err != nil {
			t.Fatal(err)
		}
	}

	q := sqlc.New(pool)
	if n, err := q.CountUsers(ctx); err != nil || n != 1 {
		t.Fatalf("%d users, err %v", n, err)
	}
	admin, err := q.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !admin.Admin || !admin.MustChangePassword || !admin.Active || admin.CreatedBy.Valid {
		t.Errorf("unexpected admin %+v", admin)
	}
	if !auth.CheckPassword(admin.PasswordHash, auth.DefaultAdminPassword) {
		t.Error("admin doesn't have the default password")
	}
	if !strings.Contains(logs.String(), "default password") {
		t.Errorf("no warning about the default password: %s", logs.String())
	}
}

func TestEnsureInitialAdminCustomPassword(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	logger := slog.New(slog.DiscardHandler)

	if err := auth.EnsureInitialAdmin(ctx, pool, "short", logger); err == nil {
		t.Fatal("a password that breaks the policy must be refused")
	}
	if err := auth.EnsureInitialAdmin(ctx, pool, "my own admin password", logger); err != nil {
		t.Fatal(err)
	}
	admin, err := sqlc.New(pool).GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !auth.CheckPassword(admin.PasswordHash, "my own admin password") {
		t.Error("BUCKY_INITIAL_ADMIN_PASSWORD was not used")
	}
}
