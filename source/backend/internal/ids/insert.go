package ids

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// MaxAttempts caps how many IDs Insert tries before giving up.
const MaxAttempts = 10

// ErrIDSpaceExhausted means Insert found no free ID within MaxAttempts. For
// small ID spaces (9,000 account IDs) it can mean the space is nearly full.
var ErrIDSpaceExhausted = errors.New("no free ID found")

// Insert inserts a row under a freshly generated ID, drawing a new one if the
// ID is taken, and returns the ID it used.
//
// insert must report a taken ID by returning false, not an error. Write the
// query as
//
//	INSERT INTO … VALUES (…) ON CONFLICT (id) DO NOTHING RETURNING id
//
// and pass its error through Inserted. A suppressed conflict doesn't abort the
// surrounding transaction, so this works inside one without savepoints, and
// other unique violations (e.g. a duplicate username) still fail as usual.
func Insert(ctx context.Context, kind Kind, gen func() string, insert func(ctx context.Context, id string) (bool, error)) (string, error) {
	for range MaxAttempts {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		id := gen()
		ok, err := insert(ctx, id)
		if err != nil {
			return "", err
		}
		if ok {
			return id, nil
		}
	}
	return "", fmt.Errorf("%s ID: %w after %d attempts", kind.Name, ErrIDSpaceExhausted, MaxAttempts)
}

// Inserted adapts the error of an `ON CONFLICT (id) DO NOTHING RETURNING id`
// query for Insert: no row returned means the ID was taken.
func Inserted(err error) (bool, error) {
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
