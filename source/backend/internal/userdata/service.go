package userdata

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/preferences"
)

// App marks a file as this app's export.
const App = "bucky-budgetr"

// Format is the export file's format. Bump it when a per-user table's
// existing column is renamed, removed or changes meaning (a new column with
// a default needs nothing: older files get the default), or when the
// preferences' shape changes, and teach upgrade to convert the older
// format. TestColumns lists the columns, so a schema change shows up there
// first.
//
// Format 2 (#201): saved modules and module widgets instead of saved graphs
// and graph widgets.
const Format = 2

// ErrNewer means the file is from a newer version of the app, which this one
// can't read.
var ErrNewer = errors.New("the export is from a newer version of the app")

// File is a user's data as an export file (#36).
type File struct {
	App           string    `json:"app"`
	Format        int       `json:"format"`
	SchemaVersion int64     `json:"schema_version"`
	ExportedAt    time.Time `json:"exported_at"`
	UserID        string    `json:"user_id"`
	Username      string    `json:"username"`
	Data          Data      `json:"data"`
}

// Counts sums up what an import wrote.
type Counts struct {
	Accounts, Buckets, Cycles, Transactions, Schedules int
}

// Options configures a Service.
type Options struct {
	// Now returns the current time, for the export's time. Defaults to
	// time.Now.
	Now func() time.Time
}

// Service exports and imports users' data.
type Service struct {
	pool *pgxpool.Pool
	opts Options
}

// NewService returns a Service.
func NewService(pool *pgxpool.Pool, opts Options) *Service {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, opts: opts}
}

// Export returns everything the user has, as of one moment.
func (s *Service) Export(ctx context.Context, userID string) (File, error) {
	f := File{App: App, Format: Format, ExportedAt: s.opts.Now().UTC(), UserID: userID}
	err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead}, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, userID).Scan(&f.Username); err != nil {
			return err
		}
		var err error
		if f.SchemaVersion, err = SchemaVersion(ctx, tx); err != nil {
			return err
		}
		f.Data, err = Read(ctx, tx, userID)
		return err
	})
	if err != nil {
		return File{}, err
	}
	return f, nil
}

// ParseFile reads an export file, keeping amounts exact.
func ParseFile(raw []byte) (File, error) {
	var f File
	if err := Decode(raw, &f); err != nil {
		return File{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if f.App != App {
		return File{}, fmt.Errorf("%w: not a Bucky BudgetR export", ErrInvalid)
	}
	if f.Format > Format {
		return File{}, ErrNewer
	}
	if f.Format < 1 || f.UserID == "" {
		return File{}, fmt.Errorf("%w: format %d", ErrInvalid, f.Format)
	}
	return upgrade(f)
}

// upgrade converts a file of an older format to the current one, as the
// migrations converted the database.
func upgrade(f File) (File, error) {
	if f.Format < 2 {
		p, _, err := preferences.ConvertJSON(f.Data.Preferences, preferences.SavedModulesUp)
		if err != nil {
			return File{}, fmt.Errorf("%w: %w", ErrInvalid, err)
		}
		f.Data.Preferences, f.Format = p, 2
	}
	return f, nil
}

// Import replaces everything the user has with the file's data, in one
// transaction, and recalculates the funds allocations. The file is the
// user's own (the IDs are kept) when it was exported by the same user ID.
func (s *Service) Import(ctx context.Context, userID string, f File) (Counts, error) {
	var counts Counts
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		data, err := Replace(ctx, tx, userID, f.UserID, f.Data)
		if err != nil {
			return err
		}
		accounts, err := sqlc.New(tx).ListAccounts(ctx, userID)
		if err != nil {
			return err
		}
		ids := make([]string, len(accounts))
		for i, a := range accounts {
			ids[i] = a.ID
		}
		if err := allocation.Run(ctx, tx, userID, ids, true); err != nil {
			return fmt.Errorf("allocation: %w", err)
		}
		counts = CountOf(data)
		return nil
	})
	return counts, err
}

// CountOf sums up the live accounts and buckets, the cycles, the
// transactions (not their corrections) and the schedules.
func CountOf(d Data) Counts {
	live := func(rows []Row) int {
		n := 0
		for _, r := range rows {
			if r["deleted"] != true {
				n++
			}
		}
		return n
	}
	originals := 0
	for _, r := range d.Tables["transaction_headers"] {
		if r["parent_id"] == nil {
			originals++
		}
	}
	return Counts{
		Accounts:     live(d.Tables["bank_accounts"]),
		Buckets:      live(d.Tables["buckets"]),
		Cycles:       len(d.Tables["cycles"]),
		Transactions: originals,
		Schedules:    len(d.Tables["schedules"]),
	}
}

// SchemaVersion is the database's goose version.
func SchemaVersion(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (int64, error) {
	var v int64
	err := q.QueryRow(ctx, `SELECT coalesce(max(version_id), 0) FROM goose_db_version WHERE is_applied`).Scan(&v)
	if err != nil {
		return 0, fmt.Errorf("schema version: %w", err)
	}
	return v, nil
}
