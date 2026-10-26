package auth_test

import (
	"errors"
	"log/slog"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func newService(t *testing.T) (*auth.Service, *pgxpool.Pool) {
	t.Helper()
	pool := testdb.New(t)
	opts := auth.Options{IdleTimeout: time.Hour, MaxAge: 24 * time.Hour}
	return auth.NewService(pool, slog.New(slog.DiscardHandler), opts), pool
}

var client = auth.Client{IP: "192.0.2.1", UserAgent: "test"}

func TestTemporaryPassword(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-km-zA-HJ-NP-Z2-9]{4}(-[a-km-zA-HJ-NP-Z2-9]{4}){3}$`)
	seen := map[string]bool{}
	for range 50 {
		p, err := auth.TemporaryPassword()
		if err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(p) || regexp.MustCompile(`[0O1lI]`).MatchString(p) {
			t.Errorf("%q doesn't match the format", p)
		}
		if err := auth.ValidateNewPassword(p, ""); err != nil {
			t.Errorf("%q breaks the policy: %v", p, err)
		}
		if seen[p] {
			t.Errorf("%q came twice", p)
		}
		seen[p] = true
	}
}

func TestCreateUser(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)

	u, cred, err := svc.CreateUser(ctx, admin.ID, "kari", false, auth.CredentialPassword)
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "kari" || !u.Active || u.Admin || !u.MustChangePassword || u.CreatedBy != admin.ID || u.LastSeenAt != nil {
		t.Errorf("unexpected user %+v", u)
	}
	sess, _, err := svc.Login(ctx, "kari", cred.Password, client)
	if err != nil {
		t.Fatalf("login with the temporary password: %v", err)
	}
	if !sess.User.MustChangePassword {
		t.Error("the new user must change the password")
	}

	for _, name := range []string{"KARI", "Kari"} {
		if _, _, err := svc.CreateUser(ctx, admin.ID, name, false, auth.CredentialPassword); !errors.Is(err, auth.ErrUsernameTaken) {
			t.Errorf("%s: got %v, want ErrUsernameTaken", name, err)
		}
	}
	if _, _, err := svc.CreateUser(ctx, admin.ID, "no spaces", false, auth.CredentialPassword); !errors.Is(err, auth.ErrInvalidUsername) {
		t.Errorf("invalid username: got %v", err)
	}

	boss, _, err := svc.CreateUser(ctx, admin.ID, "boss", true, auth.CredentialPassword)
	if err != nil || !boss.Admin {
		t.Errorf("admin user: %+v, %v", boss, err)
	}

	users, err := svc.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, u := range users {
		names = append(names, u.Username)
		if u.Username == "kari" && u.LastSeenAt == nil {
			t.Error("kari logged in, so has a last seen time")
		}
	}
	if want := []string{"admin", "boss", "kari"}; !slices.Equal(names, want) {
		t.Errorf("users %v, want %v", names, want)
	}
}

func TestUpdateUser(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)
	kari := authtest.NewUser(t, pool, "kari")
	off, on := false, true

	_, token, err := svc.Login(ctx, "kari", authtest.Password, client)
	if err != nil {
		t.Fatal(err)
	}
	u, err := svc.UpdateUser(ctx, admin.ID, kari.ID, auth.UserChanges{Active: &off})
	if err != nil || u.Active {
		t.Fatalf("deactivate: %+v, %v", u, err)
	}
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrNoSession) {
		t.Errorf("kari's session must end: %v", err)
	}
	if _, _, err := svc.Login(ctx, "kari", authtest.Password, client); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Errorf("an inactive user must not log in: %v", err)
	}

	u, err = svc.UpdateUser(ctx, admin.ID, kari.ID, auth.UserChanges{Active: &on, Admin: &on})
	if err != nil || !u.Active || !u.Admin {
		t.Fatalf("activate and promote: %+v, %v", u, err)
	}

	// Admins don't change themselves here.
	if _, err := svc.UpdateUser(ctx, admin.ID, admin.ID, auth.UserChanges{Admin: &off}); !errors.Is(err, auth.ErrOwnAccount) {
		t.Errorf("own account: %v", err)
	}
	// kari demotes admin; then admin can't demote kari, the last active admin.
	if _, err := svc.UpdateUser(ctx, kari.ID, admin.ID, auth.UserChanges{Admin: &off}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []auth.UserChanges{{Admin: &off}, {Active: &off}} {
		if _, err := svc.UpdateUser(ctx, admin.ID, kari.ID, c); !errors.Is(err, auth.ErrLastAdmin) {
			t.Errorf("%+v: got %v, want ErrLastAdmin", c, err)
		}
	}
	if _, err := svc.UpdateUser(ctx, admin.ID, "999999", auth.UserChanges{Active: &on}); !errors.Is(err, auth.ErrUserNotFound) {
		t.Errorf("unknown user: %v", err)
	}
}

func TestResetPassword(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)
	kari := authtest.NewUser(t, pool, "kari")

	_, token, err := svc.Login(ctx, "kari", authtest.Password, client)
	if err != nil {
		t.Fatal(err)
	}
	cred, err := svc.ResetPassword(ctx, admin.ID, kari.ID, auth.CredentialPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrNoSession) {
		t.Errorf("kari's session must end: %v", err)
	}
	if _, _, err := svc.Login(ctx, "kari", authtest.Password, client); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Errorf("the old password must stop working: %v", err)
	}
	sess, _, err := svc.Login(ctx, "kari", cred.Password, client)
	if err != nil || !sess.User.MustChangePassword {
		t.Errorf("login with the temporary password: %v", err)
	}

	if _, err := svc.ResetPassword(ctx, admin.ID, admin.ID, auth.CredentialPassword); !errors.Is(err, auth.ErrOwnAccount) {
		t.Errorf("own account: %v", err)
	}
	if _, err := svc.ResetPassword(ctx, admin.ID, "999999", auth.CredentialPassword); !errors.Is(err, auth.ErrUserNotFound) {
		t.Errorf("unknown user: %v", err)
	}
}

func TestRecoverAdmin(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	kari := authtest.NewUser(t, pool, "kari")
	_, token, err := svc.Login(ctx, "kari", authtest.Password, client)
	if err != nil {
		t.Fatal(err)
	}
	authtest.Deactivate(t, pool, kari.ID)

	password, err := auth.RecoverAdmin(ctx, pool, "KARI")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrNoSession) {
		t.Errorf("the old session must end: %v", err)
	}
	sess, _, err := svc.Login(ctx, "kari", password, client)
	if err != nil {
		t.Fatal(err)
	}
	if u := sess.User; !u.Active || !u.Admin || !u.MustChangePassword {
		t.Errorf("want an active admin who must change the password: %+v", u)
	}
	if _, err := auth.RecoverAdmin(ctx, pool, "nobody"); !errors.Is(err, auth.ErrUserNotFound) {
		t.Errorf("unknown user: %v", err)
	}
}
