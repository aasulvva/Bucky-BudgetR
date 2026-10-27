package auth

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// Setup and reset links (spec §1): instead of a temporary password, an admin
// can hand a user a link where they choose their own password and are then
// logged in. A link works once, for LinkTTL. Only the token's SHA-256 is
// stored, as for sessions, and a user has at most one link: a new link, or a
// temporary password, voids the old one.

// LinkTTL is how long a setup or reset link works.
const LinkTTL = 24 * time.Hour

// ErrInvalidLink means the link is unknown, used, expired or its user
// inactive. They all look the same, so a link reveals nothing.
var ErrInvalidLink = errors.New("invalid or expired link")

// Credential is how a user gets in after an admin creates them or resets
// their password.
type Credential string

const (
	// CredentialPassword is a temporary password the admin hands over; the
	// user must change it when they log in.
	CredentialPassword Credential = "password"
	// CredentialLink is a link where the user chooses their own password.
	CredentialLink Credential = "link"
)

// LinkPurpose says whether a link sets up a new user or resets a password.
type LinkPurpose string

const (
	LinkSetup LinkPurpose = "setup"
	LinkReset LinkPurpose = "reset"
)

// NewCredential is what the admin hands over: a temporary password or a
// link, whichever was asked for. It is shown only once.
type NewCredential struct {
	Password string
	Link     *Link
}

// Link is a new setup or reset link. The token goes into the link's URL.
type Link struct {
	Token     string
	ExpiresAt time.Time
}

// LinkInfo describes a link that works, for the page that uses it.
type LinkInfo struct {
	Username  string
	Purpose   LinkPurpose
	ExpiresAt time.Time
}

// CheckLink tells whether a link works, and for whom.
func (s *Service) CheckLink(ctx context.Context, token string) (LinkInfo, error) {
	row, err := s.q.GetPasswordLink(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkInfo{}, ErrInvalidLink
	}
	if err != nil {
		return LinkInfo{}, err
	}
	if !s.linkWorks(row.PasswordLink, row.User) {
		return LinkInfo{}, ErrInvalidLink
	}
	return LinkInfo{
		Username:  row.User.Username,
		Purpose:   LinkPurpose(row.PasswordLink.Purpose),
		ExpiresAt: row.PasswordLink.ExpiresAt,
	}, nil
}

// UseLink sets the user's password with a link, uses the link up, ends the
// user's other sessions and starts a new one. It returns the session and the
// token for the client's cookie.
func (s *Service) UseLink(ctx context.Context, token, password string, client Client) (*Session, string, error) {
	if err := ValidateNewPassword(password, ""); err != nil {
		return nil, "", err
	}
	// Check first, so an unknown token costs no password hashing.
	if _, err := s.CheckLink(ctx, token); err != nil {
		return nil, "", err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return nil, "", err
	}
	var (
		sess   *Session
		cookie string
	)
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		link, err := q.TakePasswordLink(ctx, hashToken(token))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidLink // used by another request meanwhile
		}
		if err != nil {
			return err
		}
		user, err := q.GetUser(ctx, link.UserID)
		if err != nil {
			return err
		}
		if !s.linkWorks(link, user) {
			return ErrInvalidLink
		}
		if err := q.UpdatePassword(ctx, sqlc.UpdatePasswordParams{ID: user.ID, PasswordHash: hash}); err != nil {
			return err
		}
		if err := q.DeleteUserSessions(ctx, user.ID); err != nil {
			return err
		}
		if user, err = q.GetUser(ctx, user.ID); err != nil {
			return err
		}
		sess, cookie, err = s.startSession(ctx, q, user, client)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	return sess, cookie, nil
}

// DeleteExpiredLinks deletes links past their expiry.
func (s *Service) DeleteExpiredLinks(ctx context.Context) error {
	_, err := s.q.DeleteExpiredPasswordLinks(ctx, s.opts.Now())
	return err
}

func (s *Service) linkWorks(link sqlc.PasswordLink, user sqlc.User) bool {
	return s.opts.Now().Before(link.ExpiresAt) && user.Active
}

// issue hands a user the credential asked for, after their password has
// been replaced with password: that password itself, or a new link (the
// password then stays unknown to everyone). Either way it voids their old
// link. by is the admin, "" for none.
func (s *Service) issue(ctx context.Context, q *sqlc.Queries, by, userID string, cred Credential, purpose LinkPurpose, password string) (NewCredential, error) {
	if cred != CredentialLink {
		return NewCredential{Password: password}, q.DeleteUserPasswordLinks(ctx, userID)
	}
	token, hash := newToken()
	now := s.opts.Now()
	// In microseconds, as the database stores it.
	link := &Link{Token: token, ExpiresAt: now.Add(LinkTTL).Truncate(time.Microsecond)}
	err := q.CreatePasswordLink(ctx, sqlc.CreatePasswordLinkParams{
		TokenHash: hash,
		UserID:    userID,
		Purpose:   string(purpose),
		CreatedBy: pgtype.Text{String: by, Valid: by != ""},
		Now:       now,
		ExpiresAt: link.ExpiresAt,
	})
	return NewCredential{Link: link}, err
}
