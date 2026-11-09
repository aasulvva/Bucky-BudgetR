package auth

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
)

const (
	// InitialAdminUsername is the account created on first start.
	InitialAdminUsername = "admin"
	// DefaultAdminPassword is the spec's initial password. It must be changed
	// at first login.
	DefaultAdminPassword = "BuckyBudgetR_ADMIN_Pa$$w0rd" //nolint:gosec // documented default, forced to change
	bootstrapLockKey     = 0x6275636b7961                // "buckya"
)

// EnsureInitialAdmin creates the admin account if there are no users yet,
// with password (DefaultAdminPassword if empty) and must_change_password set.
// It is safe to run from several processes at once.
func EnsureInitialAdmin(ctx context.Context, pool *pgxpool.Pool, password string, logger *slog.Logger) error {
	isDefault := password == ""
	if isDefault {
		password = DefaultAdminPassword
	}
	if err := ValidateNewPassword(password, ""); err != nil {
		return fmt.Errorf("BUCKY_INITIAL_ADMIN_PASSWORD: %w", err)
	}

	var created string
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", bootstrapLockKey); err != nil {
			return err
		}
		q := sqlc.New(tx)
		n, err := q.CountUsers(ctx)
		if err != nil || n > 0 {
			return err
		}
		hash, err := HashPassword(password)
		if err != nil {
			return err
		}
		created, err = ids.Insert(ctx, ids.User, ids.NewUser, func(ctx context.Context, id string) (bool, error) {
			_, err := q.CreateUser(ctx, sqlc.CreateUserParams{
				ID:                 id,
				Username:           InitialAdminUsername,
				PasswordHash:       hash,
				Admin:              true,
				MustChangePassword: true,
				CreatedBy:          pgtype.Text{},
			})
			return ids.Inserted(err)
		})
		return err
	})
	if err != nil {
		return fmt.Errorf("create initial admin: %w", err)
	}
	if created != "" {
		logger.InfoContext(ctx, "created initial admin account", slog.String(logging.EventKey, "admin.initial_created"),
			slog.String("username", InitialAdminUsername), slog.String("user_id", created))
		if isDefault {
			logger.WarnContext(ctx, "the admin account uses the default password; change it at first login")
		}
	}
	return nil
}
