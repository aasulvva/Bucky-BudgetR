package ledger_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
)

// The database enforces the ledger's core rules too, for code that bypasses
// the ledger package.

func pgCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func TestLedgerIsImmutable(t *testing.T) {
	w := setup(t)
	e := w.entry(sqlc.TransactionTypeEXP)
	e.BankLines = bank(w.acc1, "-10")
	e.BucketLines = buckets(w.bucket1, "-10")
	e.Tags = []string{"x"}
	tx, err := w.ledger.Create(t.Context(), w.pool, e)
	if err != nil {
		t.Fatal(err)
	}

	for _, sql := range []string{
		"UPDATE transaction_headers SET counterparty = 'x'",
		"DELETE FROM transaction_headers",
		"UPDATE bank_transactions SET amount = 1",
		"DELETE FROM bank_transactions",
		"UPDATE bucket_transactions SET amount = 1",
		"DELETE FROM bucket_transactions",
		"UPDATE transaction_tags SET tag_id = tag_id",
		"DELETE FROM transaction_tags",
		"TRUNCATE bank_transactions CASCADE",
		"TRUNCATE transaction_headers CASCADE",
	} {
		if _, err := w.pool.Exec(t.Context(), sql); pgCode(err) != "23001" {
			t.Errorf("%s: got %v, want restrict_violation", sql, err)
		}
	}
	if _, err := ledger.Get(t.Context(), w.pool, w.user, tx.Header.ID); err != nil {
		t.Errorf("transaction gone: %v", err)
	}
}

func TestSchemaConstraints(t *testing.T) {
	w := setup(t)
	for name, tc := range map[string]struct {
		sql  string
		args []any
		code string
	}{
		"ID doesn't match the date": {
			`INSERT INTO transaction_headers (id, user_id, transaction_type, transaction_date) VALUES ('2026101612345678', $1, 'INC', '2026-10-15')`,
			[]any{w.user}, "23514",
		},
		"correction without parent": {
			`INSERT INTO transaction_headers (id, user_id, transaction_type, transaction_date, correction_type) VALUES ('2026101512345678', $1, 'INC', '2026-10-15', 'reversal')`,
			[]any{w.user}, "23514",
		},
		"second active cycle": {
			`INSERT INTO cycles (id, user_id, start_date, end_date, state) VALUES ($1 || '000001', $1, '2026-11-01', '2026-11-30', 'active')`,
			[]any{w.user}, "23505",
		},
		"cycle ending before it starts": {
			`INSERT INTO cycles (id, user_id, start_date, end_date) VALUES ($1 || '000002', $1, '2026-11-30', '2026-11-01')`,
			[]any{w.user}, "23514",
		},
		"cycle ID of another user": {
			`INSERT INTO cycles (id, user_id, start_date, end_date) VALUES ($2 || '000003', $1, '2026-11-01', '2026-11-30')`,
			[]any{w.user, w.otherUser}, "23514",
		},
		"bucket on another user's account": {
			`INSERT INTO buckets (id, user_id, name, source_account_id) VALUES ($1 || '0001', $1, 'x', $2)`,
			[]any{w.user, w.otherAc}, "23503",
		},
		"bucket line in another user's cycle": {
			`WITH h AS (INSERT INTO transaction_headers (id, user_id, transaction_type, transaction_date) VALUES ('2026101500000001', $1, 'REF', '2026-10-15') RETURNING id)
			 INSERT INTO bucket_transactions (id, transaction_id, bucket_id, cycle_id, amount) SELECT $2 || '00000000000001', h.id, $2, $3, 1 FROM h`,
			[]any{w.user, w.bucket1, w.otherUser + "000000"}, "23514",
		},
		"zero amount": {
			`WITH h AS (INSERT INTO transaction_headers (id, user_id, transaction_type, transaction_date) VALUES ('2026101500000002', $1, 'INC', '2026-10-15') RETURNING id)
			 INSERT INTO bank_transactions (id, transaction_id, account_id, amount) SELECT $2 || '000000000001', h.id, $2, 0 FROM h`,
			[]any{w.user, w.acc1}, "23514",
		},
		"currency without original amount": {
			`WITH h AS (INSERT INTO transaction_headers (id, user_id, transaction_type, transaction_date) VALUES ('2026101500000003', $1, 'INC', '2026-10-15') RETURNING id)
			 INSERT INTO bank_transactions (id, transaction_id, account_id, amount, original_currency) SELECT $2 || '000000000002', h.id, $2, 1, 'EUR' FROM h`,
			[]any{w.user, w.acc1}, "23514",
		},
	} {
		if _, err := w.pool.Exec(t.Context(), tc.sql, tc.args...); pgCode(err) != tc.code {
			t.Errorf("%s: got %v, want SQLSTATE %s", name, err, tc.code)
		}
	}

	// Tagging another user's transaction with your tag is refused.
	e := w.entry(sqlc.TransactionTypeINC)
	e.BankLines = bank(w.acc1, "1")
	e.Tags = []string{"mine"}
	if _, err := w.ledger.Create(t.Context(), w.pool, e); err != nil {
		t.Fatal(err)
	}
	other := ledger.Entry{UserID: w.otherUser, Type: sqlc.TransactionTypeINC, Date: date("2026-10-15"), BankLines: bank(w.otherAc, "1")}
	otherTx, err := w.ledger.Create(t.Context(), w.pool, other)
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.pool.Exec(t.Context(), `INSERT INTO transaction_tags (transaction_id, tag_id, user_id)
		SELECT $1, id, user_id FROM tags WHERE user_id = $2`, otherTx.Header.ID, w.user)
	if pgCode(err) != "23503" {
		t.Errorf("cross-user tag: %v", err)
	}
}
