package transactions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// MaxRenameFrom is how many counterparties a Rename can match.
const MaxRenameFrom = 10

// Rename corrects the counterparty of several transactions at once (#70):
// the account's transactions, not reversed, of Type and with Tag when given,
// whose effective counterparty is one of From (trimmed, ignoring case). Their
// counterparty becomes To, each by a correction, so it shows in its history.
type Rename struct {
	AccountID string
	Type      sqlc.TransactionType
	Tag       string
	From      []string
	To        string
	// Apply makes the corrections; without it, Rename only counts them.
	Apply bool
}

// RenameCounterparty counts the transactions r matches, or with r.Apply
// corrects them all in one database transaction. It returns how many. Another
// user's account matches nothing.
func (s *Service) RenameCounterparty(ctx context.Context, userID string, r Rename) (int, error) {
	to := strings.TrimSpace(r.To)
	switch {
	case r.AccountID == "":
		return 0, fmt.Errorf("%w: no account", ErrInvalid)
	case len(r.From) == 0 || len(r.From) > MaxRenameFrom:
		return 0, fmt.Errorf("%w: give 1–%d counterparties to rename", ErrInvalid, MaxRenameFrom)
	case to == "":
		return 0, fmt.Errorf("%w: the new counterparty is empty", ErrInvalid)
	case utf8.RuneCountInString(to) > ledger.MaxCounterparty:
		return 0, fmt.Errorf("%w: the new counterparty is longer than %d characters", ErrInvalid, ledger.MaxCounterparty)
	case r.Type != "" && !r.Type.Valid():
		return 0, fmt.Errorf("%w: transaction type %q", ErrInvalid, r.Type)
	}
	from := make(map[string]bool, len(r.From))
	for _, f := range r.From {
		from[strings.ToLower(strings.TrimSpace(f))] = true
	}

	notReversed := false
	f := Filter{AccountIDs: []string{r.AccountID}, Tags: []string{r.Tag}, Reversed: &notReversed, Limit: MaxLimit}
	if r.Type != "" {
		f.Types = []sqlc.TransactionType{r.Type}
	}
	var ids []string
	for {
		page, err := s.List(ctx, userID, f)
		if err != nil {
			return 0, err
		}
		for _, t := range page.Items {
			if from[strings.ToLower(t.Counterparty)] && t.Counterparty != to {
				ids = append(ids, t.ID)
			}
		}
		if page.Next == "" {
			break
		}
		f.Cursor = page.Next
	}
	if !r.Apply || len(ids) == 0 {
		return len(ids), nil
	}

	n := 0
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		for _, id := range ids {
			_, err := s.correct(ctx, tx, userID, id, Changes{Counterparty: &to})
			switch {
			case errors.Is(err, ErrNoChange):
			case err != nil:
				return err
			default:
				n++
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return n, nil
}
