package httpapi

import (
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
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
	return &cards.Fields{
		DefaultAccountID: deref(f.DefaultAccountId), CreditLimit: limit, StatementDay: f.StatementDay, DueDay: f.DueDay,
		MinimumPayment: minimum,
	}, nil
}

func toAPICard(st cards.Status) api.CreditCard {
	out := api.CreditCard{
		DefaultAccountId: nullable.NewNullNullable[api.AccountId](),
		CreditLimit:      st.CreditLimit.StringFixed(money.Places),
		StatementDay:     st.StatementDay,
		DueDay:           st.DueDay,
		MinimumPayment:   st.MinimumPayment.StringFixed(money.Places),
		Owed:             st.Owed.StringFixed(money.Places),
		Available:        st.Available.StringFixed(money.Places),
	}
	if st.DefaultAccountID != "" {
		out.DefaultAccountId = nullable.NewNullableWithValue(st.DefaultAccountID)
	}
	return out
}
