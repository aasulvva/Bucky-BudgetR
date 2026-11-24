package httpapi

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"slices"

	"github.com/oapi-codegen/nullable"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// cardError maps errors from the cards package (#260) to problems, or
// returns nil for another error.
func cardError(err error) error {
	var over *cards.OverLimitError
	switch {
	case errors.As(err, &over):
		return &Error{Status: http.StatusConflict, Code: "over_credit_limit",
			Detail: "This takes the credit card past its credit limit: " + over.Available.StringFixed(money.Places) +
				" is available. Confirm to record it anyway."}
	case errors.Is(err, cards.ErrDefaultAccount):
		return &Error{Status: http.StatusBadRequest, Code: "card_default_account",
			Detail: "The default account must be a usage or savings account in the card's currency."}
	case errors.Is(err, cards.ErrTypeChange):
		return &Error{Status: http.StatusBadRequest, Code: "card_type",
			Detail: "An account can't change to or from a credit card. Create a new account instead."}
	case errors.Is(err, cards.ErrAutoFinalize):
		return &Error{Status: http.StatusBadRequest, Code: "card_auto_finalize",
			Detail: "Auto-finalize pays the bill from the card's default account: choose one first."}
	case errors.Is(err, cards.ErrSource):
		return &Error{Status: http.StatusBadRequest, Code: "card_source",
			Detail: "A credit card can't fund a bucket or hold savings."}
	case errors.Is(err, cards.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, cards.ErrInvalid), Err: err}
	}
	return nil
}

// cardFields parses a card's fields from the API.
func cardFields(f *api.CreditCardFields) (*cards.Fields, error) {
	if f == nil {
		return nil, nil
	}
	limit, err := parseAmount(f.CreditLimit)
	if err != nil {
		return nil, err
	}
	minimum, err := parseAmount(f.MinimumPayment)
	if err != nil {
		return nil, err
	}
	out := &cards.Fields{
		DefaultAccountID: deref(f.DefaultAccountId), CreditLimit: limit, StatementDay: f.StatementDay, DueDay: f.DueDay,
		MinimumPayment: minimum,
	}
	if p := f.Pay; p != nil {
		pay := cards.Pay{
			Rule: sqlc.CardPayRule(p.Rule), DaysBefore: p.DaysBefore, Mode: sqlc.ScheduleMode(p.Mode), AutoFinalize: p.AutoFinalize,
		}
		if p.Amount.IsSpecified() && !p.Amount.IsNull() {
			if pay.Amount, err = parseAmount(p.Amount.MustGet()); err != nil {
				return nil, err
			}
		}
		out.Pay = &pay
	}
	return out, nil
}

func toAPIPay(p *cards.Pay) api.CardPayDefaults {
	out := api.CardPayDefaults{Rule: api.CardPayRuleFull, Mode: api.ScheduleModeApprove, Amount: nullable.NewNullNullable[api.Amount]()}
	if p == nil {
		return out
	}
	out = api.CardPayDefaults{
		Rule: api.CardPayRule(p.Rule), DaysBefore: p.DaysBefore, Mode: api.ScheduleMode(p.Mode), AutoFinalize: p.AutoFinalize,
		Amount: nullable.NewNullNullable[api.Amount](),
	}
	if p.Rule == cards.PayFixed {
		out.Amount.Set(p.Amount.StringFixed(money.Places))
	}
	return out
}

func toAPICard(st cards.Status) api.CreditCard {
	out := api.CreditCard{
		DefaultAccountId: nullable.NewNullNullable[api.AccountId](),
		CreditLimit:      st.CreditLimit.StringFixed(money.Places),
		StatementDay:     st.StatementDay,
		DueDay:           st.DueDay,
		MinimumPayment:   st.MinimumPayment.StringFixed(money.Places),
		Pay:              toAPIPay(st.Pay),
		Owed:             st.Owed.StringFixed(money.Places),
		Available:        st.Available.StringFixed(money.Places),
		HeldOn:           make([]api.CardHeldOn, len(st.HeldOn)),
		SetAside:         st.SetAside.StringFixed(money.Places),
		NotSetAside:      st.NotSetAside.StringFixed(money.Places),
	}
	if st.Bill != nil {
		out.Bill = toAPIBill(*st.Bill)
	}
	for i, h := range st.HeldOn {
		out.HeldOn[i] = api.CardHeldOn{AccountId: h.AccountID, Amount: h.Amount.StringFixed(money.Places)}
	}
	if st.DefaultAccountID != "" {
		out.DefaultAccountId = nullable.NewNullableWithValue(st.DefaultAccountID)
	}
	return out
}

// toAPICardHolds lists what's held on an account per card, by card ID.
func toAPICardHolds(holds map[string]decimal.Decimal) []api.CardHold {
	out := make([]api.CardHold, 0, len(holds))
	for _, card := range slices.Sorted(maps.Keys(holds)) {
		out = append(out, api.CardHold{CardId: card, Amount: holds[card].StringFixed(money.Places)})
	}
	return out
}

func (s *server) SetAsideCardDebt(ctx context.Context, req api.SetAsideCardDebtRequestObject) (api.SetAsideCardDebtResponseObject, error) {
	a, err := s.cardDebt(ctx, req.AccountId, *req.Body, true)
	if err != nil {
		return nil, err
	}
	return api.SetAsideCardDebt200JSONResponse(a), nil
}

func (s *server) ReleaseCardDebt(ctx context.Context, req api.ReleaseCardDebtRequestObject) (api.ReleaseCardDebtResponseObject, error) {
	a, err := s.cardDebt(ctx, req.AccountId, *req.Body, false)
	if err != nil {
		return nil, err
	}
	return api.ReleaseCardDebt200JSONResponse(a), nil
}

// cardDebt sets card debt aside on an account, or releases it (#261), and
// returns the card.
func (s *server) cardDebt(ctx context.Context, cardID string, b api.CardDebtChange, hold bool) (api.Account, error) {
	svc, err := s.transactionService()
	if err != nil {
		return api.Account{}, err
	}
	amount, err := parseAmount(b.Amount)
	if err != nil {
		return api.Account{}, err
	}
	userID := sessionFrom(ctx).User.ID
	if hold {
		_, err = svc.SetAsideCardDebt(ctx, userID, cardID, b.AccountId, amount)
	} else {
		_, err = svc.ReleaseCardDebt(ctx, userID, cardID, b.AccountId, amount)
	}
	if errors.Is(err, transactions.ErrNotFound) {
		return api.Account{}, accountError(accounts.ErrNotFound)
	}
	if err != nil {
		return api.Account{}, transactionError(err)
	}
	a, err := s.accounts.Get(ctx, userID, cardID)
	if err != nil {
		return api.Account{}, accountError(err)
	}
	return toAPIAccount(a), nil
}
