package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
)

// User management for admins (spec §1): creating users, activating and
// deactivating them, granting and revoking admin, and resetting passwords.
// Users are never deleted. New and reset passwords are generated temporary
// ones that the user must change at their next login.

var (
	ErrUserNotFound    = errors.New("user not found")
	ErrUsernameTaken   = errors.New("username taken")
	ErrInvalidUsername = errors.New("invalid username")
	// ErrLastAdmin means the change would leave no active admin.
	ErrLastAdmin = errors.New("last active admin")
	// ErrOwnAccount means an admin tried to change themselves here; they use
	// their own settings instead.
	ErrOwnAccount = errors.New("own account")
)

// adminLockKey serializes admin changes, so two at once can't remove the
// last active admin.
const adminLockKey = 0x6275636b7962 // "buckyb"

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{3,32}$`)

// ManagedUser is a user as admins see them.
type ManagedUser struct {
	ID                 string
	Username           string
	Active             bool
	Admin              bool
	MustChangePassword bool
	CreatedAt          time.Time
	// CreatedBy is the admin who created the user; "" for the initial admin.
	CreatedBy string
	// LastSeenAt is when one of the user's sessions was last used; nil
	// without a session.
	LastSeenAt *time.Time
}

// UserChanges says what UpdateUser changes; nil leaves a field as it is.
type UserChanges struct {
	Active *bool
	Admin  *bool
}

// passwordAlphabet leaves out characters that look alike (0/O, 1/l/I).
const passwordAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// TemporaryPassword returns a random password in four groups of four
// characters, e.g. "k7Qm-2xTf-Rw9b-HnP4", for an admin to hand over.
func TemporaryPassword() (string, error) {
	var b strings.Builder
	n := big.NewInt(int64(len(passwordAlphabet)))
	for i := range 16 {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		r, err := rand.Int(rand.Reader, n)
		if err != nil {
			return "", fmt.Errorf("temporary password: %w", err)
		}
		b.WriteByte(passwordAlphabet[r.Int64()])
	}
	return b.String(), nil
}

// ListUsers returns every user, sorted by username.
func (s *Service) ListUsers(ctx context.Context) ([]ManagedUser, error) {
	users, err := s.q.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	seen, err := lastSeen(ctx, s.q)
	if err != nil {
		return nil, err
	}
	out := make([]ManagedUser, len(users))
	for i, u := range users {
		out[i] = managed(u, seen)
	}
	return out, nil
}

// CreateUser creates an active user with a temporary password, which it
// returns. by is the admin creating them.
func (s *Service) CreateUser(ctx context.Context, by, username string, admin bool) (ManagedUser, string, error) {
	if !usernamePattern.MatchString(username) {
		return ManagedUser{}, "", ErrInvalidUsername
	}
	password, hash, err := newTemporaryPassword()
	if err != nil {
		return ManagedUser{}, "", err
	}
	id, err := ids.Insert(ctx, ids.User, ids.NewUser, func(ctx context.Context, id string) (bool, error) {
		_, err := s.q.CreateUser(ctx, sqlc.CreateUserParams{
			ID:                 id,
			Username:           username,
			PasswordHash:       hash,
			Admin:              admin,
			MustChangePassword: true,
			CreatedBy:          pgtype.Text{String: by, Valid: true},
		})
		return ids.Inserted(err)
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_username_key" {
		return ManagedUser{}, "", ErrUsernameTaken
	}
	if err != nil {
		return ManagedUser{}, "", fmt.Errorf("create user: %w", err)
	}
	u, err := s.user(ctx, s.q, id)
	return u, password, err
}

// UpdateUser activates or deactivates a user, or grants or revokes admin.
// Deactivating ends their sessions. by is the admin making the change, who
// can't change themselves, and the last active admin stays one.
func (s *Service) UpdateUser(ctx context.Context, by, id string, c UserChanges) (ManagedUser, error) {
	if id == by {
		return ManagedUser{}, ErrOwnAccount
	}
	var out ManagedUser
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", adminLockKey); err != nil {
			return err
		}
		q := s.q.WithTx(tx)
		cur, err := q.GetUserForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserNotFound
		}
		if err != nil {
			return err
		}
		active, admin := cur.Active, cur.Admin
		if c.Active != nil {
			active = *c.Active
		}
		if c.Admin != nil {
			admin = *c.Admin
		}
		if cur.Active && cur.Admin && (!active || !admin) {
			others, err := q.CountOtherActiveAdmins(ctx, id)
			if err != nil {
				return err
			}
			if others == 0 {
				return ErrLastAdmin
			}
		}
		if err := q.UpdateUserFlags(ctx, sqlc.UpdateUserFlagsParams{ID: id, Active: active, Admin: admin}); err != nil {
			return err
		}
		if cur.Active && !active {
			if err := q.DeleteUserSessions(ctx, id); err != nil {
				return err
			}
		}
		out, err = s.user(ctx, q, id)
		return err
	})
	return out, err
}

// ResetPassword gives a user a new temporary password, which it returns,
// and ends their sessions. by is the admin resetting it; admins change their
// own password with ChangePassword.
func (s *Service) ResetPassword(ctx context.Context, by, id string) (string, error) {
	if id == by {
		return "", ErrOwnAccount
	}
	password, hash, err := newTemporaryPassword()
	if err != nil {
		return "", err
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		n, err := q.SetTemporaryPassword(ctx, sqlc.SetTemporaryPasswordParams{ID: id, PasswordHash: hash})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrUserNotFound
		}
		return q.DeleteUserSessions(ctx, id)
	})
	if err != nil {
		return "", err
	}
	return password, nil
}

// RecoverAdmin is the way back in when no admin can log in (the
// reset-password command): it gives the user a temporary password, which it
// returns, makes them an active admin and ends their sessions.
func RecoverAdmin(ctx context.Context, pool *pgxpool.Pool, username string) (string, error) {
	password, hash, err := newTemporaryPassword()
	if err != nil {
		return "", err
	}
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		q := sqlc.New(tx)
		id, err := q.RecoverUser(ctx, sqlc.RecoverUserParams{PasswordHash: hash, Username: username})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserNotFound
		}
		if err != nil {
			return err
		}
		return q.DeleteUserSessions(ctx, id)
	})
	if err != nil {
		return "", err
	}
	return password, nil
}

func newTemporaryPassword() (password, hash string, err error) {
	password, err = TemporaryPassword()
	if err != nil {
		return "", "", err
	}
	hash, err = HashPassword(password)
	return password, hash, err
}

func (s *Service) user(ctx context.Context, q *sqlc.Queries, id string) (ManagedUser, error) {
	u, err := q.GetUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ManagedUser{}, ErrUserNotFound
	}
	if err != nil {
		return ManagedUser{}, err
	}
	seen, err := lastSeen(ctx, q)
	if err != nil {
		return ManagedUser{}, err
	}
	return managed(u, seen), nil
}

func lastSeen(ctx context.Context, q *sqlc.Queries) (map[string]time.Time, error) {
	rows, err := q.LastSeenByUser(ctx)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]time.Time, len(rows))
	for _, r := range rows {
		seen[r.UserID] = r.LastSeenAt
	}
	return seen, nil
}

func managed(u sqlc.User, seen map[string]time.Time) ManagedUser {
	m := ManagedUser{
		ID:                 u.ID,
		Username:           u.Username,
		Active:             u.Active,
		Admin:              u.Admin,
		MustChangePassword: u.MustChangePassword,
		CreatedAt:          u.CreatedAt,
		CreatedBy:          u.CreatedBy.String,
	}
	if t, ok := seen[u.ID]; ok {
		m.LastSeenAt = &t
	}
	return m
}
