package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

func (s *server) ListTransactions(ctx context.Context, req api.ListTransactionsRequestObject) (api.ListTransactionsResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	p := req.Params
	f := transactions.Filter{
		AccountID: deref(p.AccountId), BucketID: deref(p.BucketId), CycleID: deref(p.CycleId),
		Tag: deref(p.Tag), Counterparty: deref(p.Counterparty), Limit: deref(p.Limit), Cursor: deref(p.Cursor),
	}
	if p.Type != nil {
		for _, t := range *p.Type {
			f.Types = append(f.Types, sqlc.TransactionType(t))
		}
	}
	if p.From != nil {
		f.From = *p.From
	}
	if p.To != nil {
		f.To = *p.To
	}
	page, err := svc.List(ctx, sessionFrom(ctx).User.ID, f)
	if err != nil {
		return nil, transactionError(err)
	}
	out := api.ListTransactions200JSONResponse{Items: make([]api.Transaction, len(page.Items)), NextCursor: nullable.NewNullNullable[string]()}
	for i, t := range page.Items {
		out.Items[i] = toAPITransaction(t)
	}
	if page.Next != "" {
		out.NextCursor.Set(page.Next)
	}
	return out, nil
}

func (s *server) CreateTransaction(ctx context.Context, req api.CreateTransactionRequestObject) (api.CreateTransactionResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	n := transactions.New{
		Type: sqlc.TransactionType(b.Type), Counterparty: deref(b.Counterparty),
		AccountID: b.AccountId, ToAccountID: deref(b.ToAccountId), TriggersRefill: b.TriggersRefill,
	}
	if b.At != nil {
		n.At = *b.At
	}
	if b.Tags != nil {
		n.Tags = *b.Tags
	}
	if n.Amount, err = parseAmount(b.Amount); err != nil {
		return nil, err
	}
	if b.BucketLines != nil {
		for _, l := range *b.BucketLines {
			amount, err := parseAmount(l.Amount)
			if err != nil {
				return nil, err
			}
			n.Buckets = append(n.Buckets, transactions.BucketAmount{BucketID: l.BucketId, Amount: amount})
		}
	}
	t, err := svc.Create(ctx, sessionFrom(ctx).User.ID, n)
	if err != nil {
		return nil, transactionError(err)
	}
	return api.CreateTransaction201JSONResponse(toAPITransaction(t)), nil
}

func (s *server) GetTransaction(ctx context.Context, req api.GetTransactionRequestObject) (api.GetTransactionResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	t, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.TransactionId)
	if err != nil {
		return nil, transactionError(err)
	}
	return api.GetTransaction200JSONResponse(toAPITransaction(t)), nil
}

func (s *server) CorrectTransaction(ctx context.Context, req api.CorrectTransactionRequestObject) (api.CorrectTransactionResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	c := transactions.Changes{
		AccountID: b.AccountId, ToAccountID: b.ToAccountId, Counterparty: b.Counterparty, Tags: b.Tags,
		TriggersRefill: b.TriggersRefill,
	}
	if b.Amount != nil {
		d, err := parseAmount(*b.Amount)
		if err != nil {
			return nil, err
		}
		c.Amount = &d
	}
	if b.BucketLines != nil {
		c.SetBuckets, c.Buckets = true, []transactions.BucketAmount{}
		for _, l := range *b.BucketLines {
			amount, err := parseAmount(l.Amount)
			if err != nil {
				return nil, err
			}
			c.Buckets = append(c.Buckets, transactions.BucketAmount{BucketID: l.BucketId, Amount: amount})
		}
	}
	t, err := svc.Correct(ctx, sessionFrom(ctx).User.ID, req.TransactionId, c)
	if err != nil {
		return nil, transactionError(err)
	}
	return api.CorrectTransaction200JSONResponse(toAPITransaction(t)), nil
}

func (s *server) ReverseTransaction(ctx context.Context, req api.ReverseTransactionRequestObject) (api.ReverseTransactionResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	t, err := svc.Reverse(ctx, sessionFrom(ctx).User.ID, req.TransactionId)
	if err != nil {
		return nil, transactionError(err)
	}
	return api.ReverseTransaction200JSONResponse(toAPITransaction(t)), nil
}

func (s *server) transactionService() (*transactions.Service, error) {
	if s.transactions == nil {
		return nil, NewError(http.StatusServiceUnavailable, "transactions_unavailable", "")
	}
	return s.transactions, nil
}

// transactionError maps errors from the transactions service to problems.
func transactionError(err error) error {
	switch {
	case errors.Is(err, transactions.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Transaction not found.", Err: err}
	case errors.Is(err, transactions.ErrNotCorrectable):
		return &Error{Status: http.StatusConflict, Code: "not_correctable",
			Detail: "System transactions of this type can't be corrected or reversed.", Err: err}
	case errors.Is(err, transactions.ErrAlreadyReversed):
		return &Error{Status: http.StatusConflict, Code: "already_reversed", Detail: "The transaction has been reversed."}
	case errors.Is(err, transactions.ErrBucketLinesLocked):
		return &Error{Status: http.StatusConflict, Code: "bucket_lines_locked",
			Detail: "The transaction is outside the active cycle, so its bucket lines can't change. You can still change the bank amount, counterparty and tags.", Err: err}
	case errors.Is(err, transactions.ErrNoChange):
		return &Error{Status: http.StatusBadRequest, Code: "no_change", Detail: "Nothing would change.", Err: err}
	case errors.Is(err, transactions.ErrCurrencyMismatch):
		return &Error{Status: http.StatusBadRequest, Code: "currency_mismatch",
			Detail: "A transfer can only go between accounts in the same currency."}
	case errors.Is(err, transactions.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, transactions.ErrInvalid), Err: err}
	case errors.Is(err, ledger.ErrInvalid):
		// The ledger checks what the user entered too: tags, counterparty,
		// a bucket given twice.
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, ledger.ErrInvalid), Err: err}
	}
	return refillError(err)
}

func (s *server) ListTags(ctx context.Context, req api.ListTagsRequestObject) (api.ListTagsResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	tags, err := svc.Tags(ctx, sessionFrom(ctx).User.ID, deref(req.Params.Q), deref(req.Params.Limit))
	if err != nil {
		return nil, transactionError(err)
	}
	out := make(api.ListTags200JSONResponse, len(tags))
	for i, t := range tags {
		out[i] = api.Tag{Name: t.Name, LastUsedAt: nullable.NewNullNullable[time.Time]()}
		if !t.LastUsed.IsZero() {
			out[i].LastUsedAt.Set(t.LastUsed)
		}
	}
	return out, nil
}

func (s *server) ListCounterparties(ctx context.Context, req api.ListCounterpartiesRequestObject) (api.ListCounterpartiesResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	var typ sqlc.TransactionType
	if req.Params.Type != nil {
		typ = sqlc.TransactionType(*req.Params.Type)
	}
	list, err := svc.Counterparties(ctx, sessionFrom(ctx).User.ID, deref(req.Params.Q), typ, deref(req.Params.Limit))
	if err != nil {
		return nil, transactionError(err)
	}
	out := make(api.ListCounterparties200JSONResponse, len(list))
	for i, c := range list {
		out[i] = api.CounterpartySuggestion{
			Counterparty: c.Counterparty, Type: api.CounterpartySuggestionType(c.Type), At: c.At,
			AccountId: c.AccountID, Tags: c.Tags, BucketIds: c.BucketIDs,
		}
	}
	return out, nil
}

func toAPITransaction(t transactions.Transaction) api.Transaction {
	out := api.Transaction{
		Id:             t.ID,
		Type:           api.TransactionType(t.Type),
		At:             t.At.UTC(),
		Counterparty:   t.Counterparty,
		Tags:           t.Tags,
		TriggersRefill: t.TriggersRefill,
		CreatedAt:      t.CreatedAt.UTC(),
		CreatedBy:      nullableString(t.CreatedBy),
		Corrected:      t.Corrected,
		Reversed:       t.Reversed,
		Replaces:       nullableString(t.Replaces),
		ReplacedBy:     nullableString(t.ReplacedBy),
		BankLines:      toAPIBankLines(t.BankLines),
		BucketLines:    toAPIBucketLines(t.BucketLines),
		BeforeReversal: nullable.NewNullNullable[api.TransactionLines](),
	}
	if b := t.BeforeReversal; b != nil {
		out.BeforeReversal = nullable.NewNullableWithValue(api.TransactionLines{
			BankLines: toAPIBankLines(b.Bank), BucketLines: toAPIBucketLines(b.Buckets),
		})
	}
	if t.History != nil {
		h := make([]api.TransactionVersion, len(t.History))
		for i, v := range t.History {
			h[i] = api.TransactionVersion{
				Id:             v.ID,
				CorrectionType: api.CorrectionType(v.Correction),
				CreatedAt:      v.CreatedAt.UTC(),
				CreatedBy:      nullableString(v.CreatedBy),
				BankLines:      toAPIBankLines(v.BankLines),
				BucketLines:    toAPIBucketLines(v.BucketLines),
			}
		}
		out.History = &h
	}
	return out
}

func toAPIBankLines(lines []transactions.BankLine) []api.TransactionBankLine {
	out := make([]api.TransactionBankLine, len(lines))
	for i, l := range lines {
		out[i] = api.TransactionBankLine{AccountId: l.AccountID, Amount: l.Amount.StringFixed(money.Places)}
	}
	return out
}

func toAPIBucketLines(lines []transactions.BucketLine) []api.TransactionBucketLine {
	out := make([]api.TransactionBucketLine, len(lines))
	for i, l := range lines {
		out[i] = api.TransactionBucketLine{BucketId: l.BucketID, CycleId: l.CycleID, Amount: l.Amount.StringFixed(money.Places)}
	}
	return out
}

// nullableString is null for "".
func nullableString(s string) nullable.Nullable[string] {
	if s == "" {
		return nullable.NewNullNullable[string]()
	}
	return nullable.NewNullableWithValue(s)
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}
