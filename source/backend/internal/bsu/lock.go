package bsu

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// ErrLocked means a BSU account is locked until its history is set up
// (#214): nothing may be recorded with it. Deleting it still works.
var ErrLocked = errors.New("the BSU account is locked until its history is set up")

// LockedError says which account is locked.
type LockedError struct{ AccountID string }

func (e *LockedError) Error() string { return fmt.Sprintf("%s: account %s", ErrLocked, e.AccountID) }

func (e *LockedError) Unwrap() error { return ErrLocked }

// LockedAccounts returns the user's locked BSU accounts: not set up yet, or
// not in NOK.
func LockedAccounts(ctx context.Context, db sqlc.DBTX, userID string) (map[string]bool, error) {
	ids, err := sqlc.New(db).ListLockedBSU(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// Locked returns *LockedError for the first of accountIDs (in order) that's
// a locked BSU account, else nil. Empty IDs are skipped.
func Locked(ctx context.Context, db sqlc.DBTX, userID string, accountIDs ...string) error {
	if !slices.ContainsFunc(accountIDs, func(id string) bool { return id != "" }) {
		return nil
	}
	locked, err := LockedAccounts(ctx, db, userID)
	if err != nil {
		return err
	}
	for _, id := range accountIDs {
		if locked[id] {
			return &LockedError{AccountID: id}
		}
	}
	return nil
}
