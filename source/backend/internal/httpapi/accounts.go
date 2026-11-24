package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/oapi-codegen/nullable"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

func (s *server) ListAccounts(ctx context.Context, _ api.ListAccountsRequestObject) (api.ListAccountsResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListAccounts200JSONResponse, len(list))
	for i, a := range list {
		out[i] = toAPIAccount(a)
	}
	return out, nil
}

func (s *server) CreateAccount(ctx context.Context, req api.CreateAccountRequestObject) (api.CreateAccountResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	n := accounts.New{Name: b.Name}
	if b.Type != nil {
		n.Type = sqlc.AccountType(*b.Type)
	}
	if b.Currency != nil {
		n.Currency = *b.Currency
	}
	if b.Bank != nil {
		n.Bank = *b.Bank
	}
	if b.OpeningBalance != nil {
		if n.OpeningBalance, err = parseAmount(*b.OpeningBalance); err != nil {
			return nil, err
		}
	}
	if b.OpeningAt != nil {
		n.OpeningAt = *b.OpeningAt
	}
	if n.Card, err = cardFields(b.CreditCard); err != nil {
		return nil, err
	}
	if b.LastStatement != nil {
		if b.CreditCard == nil {
			return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request",
				Detail: "Only a credit card has a last statement."}
		}
		if n.LastStatement, err = lastStatement(*b.LastStatement, nil); err != nil {
			return nil, err
		}
	}
	a, err := svc.Create(ctx, sessionFrom(ctx).User.ID, n)
	if err != nil {
		return nil, accountError(err)
	}
	return api.CreateAccount201JSONResponse(toAPIAccount(a)), nil
}

func (s *server) GetAccount(ctx context.Context, req api.GetAccountRequestObject) (api.GetAccountResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	a, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.AccountId)
	if err != nil {
		return nil, accountError(err)
	}
	return api.GetAccount200JSONResponse(toAPIAccount(a)), nil
}

func (s *server) UpdateAccount(ctx context.Context, req api.UpdateAccountRequestObject) (api.UpdateAccountResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	c := accounts.Changes{Name: req.Body.Name, Bank: req.Body.Bank}
	if req.Body.Type != nil {
		t := sqlc.AccountType(*req.Body.Type)
		c.Type = &t
	}
	if e := req.Body.ExpectedIncome; e.IsSpecified() {
		var income decimal.NullDecimal
		if !e.IsNull() {
			if income.Decimal, err = parseAmount(e.MustGet()); err != nil {
				return nil, err
			}
			income.Valid = true
		}
		c.ExpectedIncome = &income
	}
	if c.Card, err = cardFields(req.Body.CreditCard); err != nil {
		return nil, err
	}
	a, err := svc.Update(ctx, sessionFrom(ctx).User.ID, req.AccountId, c)
	if err != nil {
		return nil, accountError(err)
	}
	return api.UpdateAccount200JSONResponse(toAPIAccount(a)), nil
}

func (s *server) AdjustAccountBalance(ctx context.Context, req api.AdjustAccountBalanceRequestObject) (api.AdjustAccountBalanceResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	target, err := parseAmount(req.Body.TargetBalance)
	if err != nil {
		return nil, err
	}
	adj := accounts.Adjustment{Target: target}
	if req.Body.At != nil {
		adj.At = *req.Body.At
	}
	a, err := svc.AdjustBalance(ctx, sessionFrom(ctx).User.ID, req.AccountId, adj)
	if err != nil {
		return nil, accountError(err)
	}
	return api.AdjustAccountBalance200JSONResponse(toAPIAccount(a)), nil
}

func (s *server) ReallocateAccount(ctx context.Context, req api.ReallocateAccountRequestObject) (api.ReallocateAccountResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	a, err := svc.Reallocate(ctx, sessionFrom(ctx).User.ID, req.AccountId)
	if err != nil {
		return nil, accountError(err)
	}
	return api.ReallocateAccount200JSONResponse(toAPIAccount(a)), nil
}

func (s *server) DeleteAccount(ctx context.Context, req api.DeleteAccountRequestObject) (api.DeleteAccountResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	var st accounts.Settlement
	if b := req.Body; b != nil {
		if b.BucketSources != nil {
			st.BucketSources = *b.BucketSources
		}
		if b.DeleteBuckets != nil {
			st.DeleteBuckets = *b.DeleteBuckets
		}
		if r := b.RemainingFunds; r != nil {
			st.Remaining = &accounts.Remaining{Adjust: r.Action == api.Adjust}
			if r.Action == api.Transfer {
				if r.ToAccountId == nil {
					return nil, NewError(http.StatusBadRequest, "invalid_request", "A transfer needs to_account_id.")
				}
				st.Remaining.TransferTo = *r.ToAccountId
			}
		}
	}
	if err := svc.Delete(ctx, sessionFrom(ctx).User.ID, req.AccountId, st); err != nil {
		return nil, accountError(err)
	}
	return api.DeleteAccount204Response{}, nil
}

func (s *server) accountService() (*accounts.Service, error) {
	if s.accounts == nil {
		return nil, NewError(http.StatusServiceUnavailable, "accounts_unavailable", "")
	}
	return s.accounts, nil
}

// accountError maps errors from the accounts service to problems.
func accountError(err error) error {
	if e := cardError(err); e != nil {
		return e
	}
	if errors.Is(err, bsu.ErrLocked) {
		return bsuError(err)
	}
	var notZero *accounts.BalanceNotZeroError
	var hasBuckets *accounts.HasBucketsError
	switch {
	case errors.Is(err, accounts.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Account not found.", Err: err}
	case errors.Is(err, accounts.ErrNameTaken):
		return &Error{Status: http.StatusConflict, Code: "name_taken", Detail: "You already have an account with this name."}
	case errors.As(err, &notZero):
		return &Error{Status: http.StatusConflict, Code: "balance_not_zero",
			Detail: "The account still has " + notZero.Balance.StringFixed(money.Places) +
				" in it. Transfer it to another account or adjust the balance to 0."}
	case errors.As(err, &hasBuckets):
		n := len(hasBuckets.BucketIDs)
		what := strconv.Itoa(n) + " buckets use"
		if n == 1 {
			what = "1 bucket uses"
		}
		return &Error{Status: http.StatusConflict, Code: "account_has_buckets",
			Detail: capitalize(what) + " this account as their source. Choose a new source account for each, or delete them with it."}
	case errors.Is(err, accounts.ErrNoChange):
		return &Error{Status: http.StatusBadRequest, Code: "no_change", Detail: "The balance is already this amount."}
	case errors.Is(err, accounts.ErrBSUCurrency):
		return &Error{Status: http.StatusBadRequest, Code: "bsu_currency", Detail: "A BSU account must be in NOK."}
	case errors.Is(err, accounts.ErrCurrencyMismatch):
		return &Error{Status: http.StatusBadRequest, Code: "currency_mismatch",
			Detail: "Money and buckets can only move to an account in the same currency."}
	case errors.Is(err, accounts.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, accounts.ErrInvalid), Err: err}
	}
	return ledgerError(err)
}

// invalidDetail returns the message an invalid-input error carries after the
// sentinel's text, as a sentence.
func invalidDetail(err, sentinel error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, sentinel.Error()+": "); i >= 0 {
		msg = msg[i+len(sentinel.Error())+2:]
	}
	return capitalize(msg) + "."
}

// parseAmount parses an Amount. The gate has already checked its pattern.
func parseAmount(s string) (decimal.Decimal, error) {
	d, err := decimal.NewFromString(s)
	if err != nil {
		return decimal.Decimal{}, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "Invalid amount " + strconv.Quote(s) + ".", Err: err}
	}
	return d, nil
}

func toAPIAccount(a accounts.Account) api.Account {
	out := api.Account{
		Id:                a.ID,
		Name:              a.Name,
		Type:              api.AccountType(a.Type),
		Currency:          a.Currency,
		Bank:              a.Bank,
		Balance:           a.Balance.StringFixed(money.Places),
		Unallocated:       a.Unallocated.StringFixed(money.Places),
		Reserved:          a.Reserved.StringFixed(money.Places),
		ReservedUncovered: a.ReservedUncovered.StringFixed(money.Places),
		CardHolds:         toAPICardHolds(a.CardHolds),
		CardDebtUncovered: a.CardDebtUncovered.StringFixed(money.Places),
		Waiting:           a.Waiting.StringFixed(money.Places),
		ExpectedIncome:    nullable.NewNullNullable[api.Amount](),
		CreatedAt:         a.CreatedAt.UTC(),
	}
	if a.ExpectedIncome.Valid {
		out.ExpectedIncome = nullable.NewNullableWithValue(a.ExpectedIncome.Decimal.StringFixed(money.Places))
	}
	out.Bsu = nullable.NewNullNullable[api.BSUStatus]()
	if a.BSU != nil {
		out.Bsu = nullable.NewNullableWithValue(toAPIBSUStatus(*a.BSU))
	}
	out.CreditCard = nullable.NewNullNullable[api.CreditCard]()
	if a.Card != nil {
		out.CreditCard = nullable.NewNullableWithValue(toAPICard(*a.Card))
	}
	return out
}

func (s *server) ListAccountFlows(ctx context.Context, req api.ListAccountFlowsRequestObject) (api.ListAccountFlowsResponseObject, error) {
	flows, err := s.accounts.Flows(ctx, sessionFrom(ctx).User.ID, req.Params.From, req.Params.To)
	if err != nil {
		return nil, accountError(err)
	}
	amount := func(d decimal.Decimal) string { return d.StringFixed(money.Places) }
	out := make(api.ListAccountFlows200JSONResponse, len(flows))
	for i, f := range flows {
		out[i] = api.AccountFlow{
			AccountId:    f.AccountID,
			Income:       amount(f.Income),
			Expenses:     amount(f.Expenses),
			TransfersIn:  amount(f.TransfersIn),
			TransfersOut: amount(f.TransfersOut),
		}
	}
	return out, nil
}
