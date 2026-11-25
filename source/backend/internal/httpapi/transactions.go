package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
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
		AccountIDs: deref(p.AccountId), BucketIDs: deref(p.BucketId), CycleID: deref(p.CycleId),
		Tags: deref(p.Tag), Counterparty: deref(p.Counterparty), CounterpartyIs: deref(p.CounterpartyIs), Limit: deref(p.Limit), Cursor: deref(p.Cursor),
		Reversed: p.Reversed, OldestFirst: deref(p.Order) == api.ListTransactionsParamsOrderOldest,
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

// GetTransactionSummary counts and sums the transactions the filters match
// (#203), for a compact transactions module on the Dashboard.
func (s *server) GetTransactionSummary(ctx context.Context, req api.GetTransactionSummaryRequestObject) (api.GetTransactionSummaryResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	p := req.Params
	f := transactions.Filter{
		AccountIDs: deref(p.AccountId), BucketIDs: deref(p.BucketId), CycleID: deref(p.CycleId),
		Tags: deref(p.Tag), Counterparty: deref(p.Counterparty), CounterpartyIs: deref(p.CounterpartyIs),
		Reversed: p.Reversed,
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
	sum, err := svc.Summary(ctx, sessionFrom(ctx).User.ID, f)
	if err != nil {
		return nil, transactionError(err)
	}
	out := api.GetTransactionSummary200JSONResponse{Count: sum.Count, Totals: make([]api.TransactionTotals, len(sum.Totals))}
	for i, t := range sum.Totals {
		out.Totals[i] = api.TransactionTotals{
			Currency: t.Currency,
			In:       t.In.StringFixed(money.Places),
			Out:      t.Out.StringFixed(money.Places),
			Net:      t.Net.StringFixed(money.Places),
		}
	}
	return out, nil
}

func (s *server) CreateTransaction(ctx context.Context, req api.CreateTransactionRequestObject) (api.CreateTransactionResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	n, err := fromAPITransactionCreate(*req.Body)
	if err != nil {
		return nil, err
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
		AccountID: b.AccountId, ToAccountID: b.ToAccountId, Counterparty: b.Counterparty, Description: b.Description, Tags: b.Tags,
		TriggersRefill: b.TriggersRefill, BSUConfirmed: deref(b.BsuConfirmed), LimitConfirmed: deref(b.LimitConfirmed),
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
	if b.SetAsideAccountId.IsSpecified() {
		on := ""
		if v, err := b.SetAsideAccountId.Get(); err == nil {
			on = v
		}
		c.SetAsideOn = &on
	}
	if c.Carry, c.Release, err = cardChoices(b.CarryCardDebt, b.ReleaseCardDebt); err != nil {
		return nil, err
	}
	// An empty list carries nothing; left out, it keeps what it carries.
	if b.CarryCardDebt != nil && c.Carry == nil {
		c.Carry = []transactions.CardAmount{}
	}
	if c.CountLater, err = fromAPICountLater(b.CountLater); err != nil {
		return nil, err
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

func (s *server) RenameCounterparty(ctx context.Context, req api.RenameCounterpartyRequestObject) (api.RenameCounterpartyResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	r := transactions.Rename{AccountID: b.AccountId, From: b.From, To: b.To, Apply: b.Apply != nil && *b.Apply}
	if b.Type != nil {
		r.Type = sqlc.TransactionType(*b.Type)
	}
	if b.Tag != nil {
		r.Tag = *b.Tag
	}
	n, err := svc.RenameCounterparty(ctx, sessionFrom(ctx).User.ID, r)
	if err != nil {
		return nil, transactionError(err)
	}
	return api.RenameCounterparty200JSONResponse{Count: n}, nil
}

func (s *server) transactionService() (*transactions.Service, error) {
	if s.transactions == nil {
		return nil, NewError(http.StatusServiceUnavailable, "transactions_unavailable", "")
	}
	return s.transactions, nil
}

// transactionError maps errors from the transactions service to problems.
func transactionError(err error) error {
	if e := cardError(err); e != nil {
		return e
	}
	if errors.Is(err, bsu.ErrOverLimit) || errors.Is(err, bsu.ErrWithdrawal) || errors.Is(err, bsu.ErrLocked) {
		return bsuError(err)
	}
	switch {
	case errors.Is(err, transactions.ErrChargeTaken):
		return &Error{Status: http.StatusConflict, Code: "charge_taken",
			Detail: "A bucket has already taken this purchase, in a finished cycle or more than the change leaves.", Err: err}
	case errors.Is(err, transactions.ErrChargeClosed):
		return &Error{Status: http.StatusConflict, Code: "charge_closed",
			Detail: "Nothing is left for the bucket to take, or the bucket is gone.", Err: err}
	case errors.Is(err, transactions.ErrPlannedClosed):
		return plannedClosed(err)
	case errors.Is(err, transactions.ErrCardOnly):
		return &Error{Status: http.StatusBadRequest, Code: "card_only",
			Detail: "Only a credit card purchase can count in its buckets as it's paid off.", Err: err}
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
	case errors.Is(err, transactions.ErrSavingsTransfer):
		return &Error{Status: http.StatusConflict, Code: "savings_transfer",
			Detail: "This transfer took held savings off hold, so its amount and accounts can't change. Reverse it to put the money back on hold, then do Done again.", Err: err}
	case errors.Is(err, transactions.ErrNoLongerHeld):
		return &Error{Status: http.StatusConflict, Code: "not_enough_held",
			Detail: "The money is no longer held: it has been moved on or released since.", Err: err}
	case errors.Is(err, transactions.ErrNotEnoughHeld):
		return &Error{Status: http.StatusConflict, Code: "not_enough_held", Detail: capitalize(err.Error()) + ".", Err: err}
	case errors.Is(err, transactions.ErrNotEnoughUnallocated):
		return &Error{Status: http.StatusConflict, Code: "not_enough_unallocated",
			Detail: "The account doesn't have enough unallocated money to hold it.", Err: err}
	case errors.Is(err, ledger.ErrCardLine):
		return &Error{Status: http.StatusBadRequest, Code: "card_source",
			Detail: "Card debt is set aside on an account that isn't a credit card, in the card's currency.", Err: err}
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

// fromAPITransactionCreate converts a new transaction from the API.
func fromAPITransactionCreate(b api.TransactionCreate) (transactions.New, error) {
	n := transactions.New{
		Type: sqlc.TransactionType(b.Type), Counterparty: deref(b.Counterparty), Description: deref(b.Description),
		AccountID: b.AccountId, ToAccountID: deref(b.ToAccountId), TriggersRefill: b.TriggersRefill,
		BSUConfirmed: deref(b.BsuConfirmed), LimitConfirmed: deref(b.LimitConfirmed),
		PlannedID: deref(b.PlannedPurchaseId),
	}
	if b.At != nil {
		n.At = *b.At
	}
	if b.Tags != nil {
		n.Tags = *b.Tags
	}
	var err error
	if n.CountLater, err = fromAPICountLater(b.CountLater); err != nil {
		return transactions.New{}, err
	}
	if n.Amount, err = parseAmount(b.Amount); err != nil {
		return transactions.New{}, err
	}
	if b.BucketLines != nil {
		for _, l := range *b.BucketLines {
			amount, err := parseAmount(l.Amount)
			if err != nil {
				return transactions.New{}, err
			}
			n.Buckets = append(n.Buckets, transactions.BucketAmount{BucketID: l.BucketId, Amount: amount})
		}
	}
	if b.SetAsideAccountId.IsSpecified() {
		on := ""
		if v, err := b.SetAsideAccountId.Get(); err == nil {
			on = v
		}
		n.SetAsideOn = &on
	}
	if n.Carry, n.Release, err = cardChoices(b.CarryCardDebt, b.ReleaseCardDebt); err != nil {
		return transactions.New{}, err
	}
	return n, nil
}

// cardChoices parses what a transfer carries or a payment releases of held
// card debt (#261).
func cardChoices(carry *[]api.CardDebtCarry, release *[]api.CardDebtChange) ([]transactions.CardAmount, *[]transactions.AccountAmount, error) {
	var c []transactions.CardAmount
	if carry != nil {
		for _, l := range *carry {
			amount, err := parseAmount(l.Amount)
			if err != nil {
				return nil, nil, err
			}
			c = append(c, transactions.CardAmount{CardID: l.CardId, Amount: amount})
		}
	}
	var r *[]transactions.AccountAmount
	if release != nil {
		out := []transactions.AccountAmount{}
		for _, l := range *release {
			amount, err := parseAmount(l.Amount)
			if err != nil {
				return nil, nil, err
			}
			out = append(out, transactions.AccountAmount{AccountID: l.AccountId, Amount: amount})
		}
		r = &out
	}
	return c, r, nil
}

func toAPITransaction(t transactions.Transaction) api.Transaction {
	out := api.Transaction{
		Id:             t.ID,
		Type:           api.TransactionType(t.Type),
		At:             t.At.UTC(),
		Counterparty:   t.Counterparty,
		Description:    t.Description,
		Tags:           t.Tags,
		TriggersRefill: t.TriggersRefill,
		CreatedAt:      t.CreatedAt.UTC(),
		CreatedBy:      nullableString(t.CreatedBy),
		Corrected:      t.Corrected,
		Reversed:       t.Reversed,
		Replaces:       nullableString(t.Replaces),
		ReplacedBy:     nullableString(t.ReplacedBy),
		ScheduleId:     nullableString(t.ScheduleID),
		BankLines:      toAPIBankLines(t.BankLines),
		BucketLines:    toAPIBucketLines(t.BucketLines),
		SavingsLines:   toAPISavingsLines(t.SavingsLines),
		CardLines:      toAPICardLines(t.CardLines),
		WaitingLines:   toAPIWaitingLines(t.WaitingLines),
		Waiting:        toAPIWaiting(t.Waiting),
		BeforeReversal: nullable.NewNullNullable[api.TransactionLines](),
		BalancesAfter:  make([]api.TransactionBalance, len(t.BalancesAfter)),
	}
	for i, b := range t.BalancesAfter {
		out.BalancesAfter[i] = api.TransactionBalance{AccountId: b.AccountID, Balance: b.Balance.StringFixed(money.Places)}
	}
	if b := t.BeforeReversal; b != nil {
		out.BeforeReversal = nullable.NewNullableWithValue(api.TransactionLines{
			BankLines: toAPIBankLines(b.Bank), BucketLines: toAPIBucketLines(b.Buckets), SavingsLines: toAPISavingsLines(b.Savings),
			CardLines: toAPICardLines(b.Cards), WaitingLines: toAPIWaitingLines(b.Waiting),
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
				SavingsLines:   toAPISavingsLines(v.SavingsLines),
				CardLines:      toAPICardLines(v.CardLines),
				WaitingLines:   toAPIWaitingLines(v.WaitingLines),
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

func toAPISavingsLines(lines []transactions.SavingsLine) []api.TransactionSavingsLine {
	out := make([]api.TransactionSavingsLine, len(lines))
	for i, l := range lines {
		out[i] = api.TransactionSavingsLine{HolderId: l.HolderID, AccountId: l.AccountID, Amount: l.Amount.StringFixed(money.Places)}
	}
	return out
}

func toAPICardLines(lines []transactions.CardLine) []api.TransactionCardLine {
	out := make([]api.TransactionCardLine, len(lines))
	for i, l := range lines {
		out[i] = api.TransactionCardLine{CardId: l.CardID, AccountId: l.AccountID, Amount: l.Amount.StringFixed(money.Places)}
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
