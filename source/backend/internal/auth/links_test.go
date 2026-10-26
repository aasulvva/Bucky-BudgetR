package auth_test

import (
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

const newPassword = "a-brand-new-password"

func TestSetupLink(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)

	u, cred, err := svc.CreateUser(ctx, admin.ID, "kari", false, auth.CredentialLink)
	if err != nil {
		t.Fatal(err)
	}
	if cred.Link == nil || cred.Password != "" || len(cred.Link.Token) != 43 {
		t.Fatalf("want only a link: %+v", cred)
	}
	info, err := svc.CheckLink(ctx, cred.Link.Token)
	if err != nil {
		t.Fatal(err)
	}
	if info.Username != "kari" || info.Purpose != auth.LinkSetup || !info.ExpiresAt.Equal(cred.Link.ExpiresAt) {
		t.Errorf("info %+v", info)
	}
	if d := time.Until(info.ExpiresAt); d < auth.LinkTTL-time.Minute || d > auth.LinkTTL {
		t.Errorf("expires in %v, want %v", d, auth.LinkTTL)
	}

	// A weak password leaves the link working.
	if _, _, err := svc.UseLink(ctx, cred.Link.Token, "short", client); !errors.Is(err, auth.ErrWeakPassword) {
		t.Errorf("weak password: %v", err)
	}
	sess, token, err := svc.UseLink(ctx, cred.Link.Token, newPassword, client)
	if err != nil {
		t.Fatal(err)
	}
	if sess.User.ID != u.ID || sess.User.MustChangePassword {
		t.Errorf("session user %+v", sess.User)
	}
	if _, err := svc.Authenticate(ctx, token); err != nil {
		t.Errorf("the new session must work: %v", err)
	}
	if _, _, err := svc.Login(ctx, "kari", newPassword, client); err != nil {
		t.Errorf("login with the chosen password: %v", err)
	}

	// It works once.
	if _, err := svc.CheckLink(ctx, cred.Link.Token); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("check a used link: %v", err)
	}
	if _, _, err := svc.UseLink(ctx, cred.Link.Token, newPassword, client); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("use a used link: %v", err)
	}
	if _, err := svc.CheckLink(ctx, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("unknown link: %v", err)
	}
}

func TestResetLink(t *testing.T) {
	svc, pool := newService(t)
	ctx := t.Context()
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)
	kari := authtest.NewUser(t, pool, "kari")
	_, token, err := svc.Login(ctx, "kari", authtest.Password, client)
	if err != nil {
		t.Fatal(err)
	}

	first, err := svc.ResetPassword(ctx, admin.ID, kari.ID, auth.CredentialLink)
	if err != nil {
		t.Fatal(err)
	}
	// The old password and sessions end at once, before the link is used.
	if _, err := svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrNoSession) {
		t.Errorf("kari's session must end: %v", err)
	}
	if _, _, err := svc.Login(ctx, "kari", authtest.Password, client); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Errorf("the old password must stop working: %v", err)
	}
	if info, err := svc.CheckLink(ctx, first.Link.Token); err != nil || info.Purpose != auth.LinkReset {
		t.Errorf("reset link: %+v, %v", info, err)
	}

	// A new link voids the old one, and so does a temporary password.
	second, err := svc.ResetPassword(ctx, admin.ID, kari.ID, auth.CredentialLink)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CheckLink(ctx, first.Link.Token); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("the first link must stop working: %v", err)
	}
	if _, err := svc.ResetPassword(ctx, admin.ID, kari.ID, auth.CredentialPassword); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CheckLink(ctx, second.Link.Token); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("a temporary password must void the link: %v", err)
	}

	// Deactivating voids it too, and an inactive user's link doesn't work.
	third, err := svc.ResetPassword(ctx, admin.ID, kari.ID, auth.CredentialLink)
	if err != nil {
		t.Fatal(err)
	}
	authtest.Deactivate(t, pool, kari.ID)
	if _, err := svc.CheckLink(ctx, third.Link.Token); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("inactive user: %v", err)
	}
	if _, _, err := svc.UseLink(ctx, third.Link.Token, newPassword, client); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("use for an inactive user: %v", err)
	}
	on, off := true, false
	if _, err := svc.UpdateUser(ctx, admin.ID, kari.ID, auth.UserChanges{Active: &on}); err != nil {
		t.Fatal(err)
	}
	fourth, err := svc.ResetPassword(ctx, admin.ID, kari.ID, auth.CredentialLink)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateUser(ctx, admin.ID, kari.ID, auth.UserChanges{Active: &off}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateUser(ctx, admin.ID, kari.ID, auth.UserChanges{Active: &on}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CheckLink(ctx, fourth.Link.Token); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("deactivating must void the link: %v", err)
	}
}

func TestLinkExpiry(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	now := time.Now()
	svc := auth.NewService(pool, slog.New(slog.DiscardHandler), auth.Options{
		IdleTimeout: time.Hour,
		MaxAge:      24 * time.Hour,
		Now:         func() time.Time { return now },
	})
	admin := authtest.NewUser(t, pool, "admin", authtest.Admin)
	_, cred, err := svc.CreateUser(ctx, admin.ID, "kari", false, auth.CredentialLink)
	if err != nil {
		t.Fatal(err)
	}

	now = now.Add(auth.LinkTTL - time.Second)
	if _, err := svc.CheckLink(ctx, cred.Link.Token); err != nil {
		t.Errorf("just before expiry: %v", err)
	}
	now = now.Add(time.Second)
	if _, err := svc.CheckLink(ctx, cred.Link.Token); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("at expiry: %v", err)
	}
	if _, _, err := svc.UseLink(ctx, cred.Link.Token, newPassword, client); !errors.Is(err, auth.ErrInvalidLink) {
		t.Errorf("use at expiry: %v", err)
	}
	if err := svc.DeleteExpiredLinks(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM password_links").Scan(&n); err != nil || n != 0 {
		t.Errorf("links left: %d, %v", n, err)
	}
}
