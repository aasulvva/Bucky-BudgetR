package httpapi

// A credit card's bill (#262, spec §2.2).

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// billError maps the bill's errors to problems, or returns nil.
func billError(err error) error {
	switch {
	case errors.Is(err, cards.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Account not found.", Err: err}
	case errors.Is(err, cards.ErrNotCard):
		return &Error{Status: http.StatusBadRequest, Code: "not_a_card", Detail: "The account isn't a credit card."}
	case errors.Is(err, cards.ErrBillSetUp):
		return &Error{Status: http.StatusConflict, Code: "bill_set_up", Detail: "The card's bill is set up already."}
	case errors.Is(err, cards.ErrBillNotSetUp):
		return &Error{Status: http.StatusConflict, Code: "bill_not_set_up",
			Detail: "Set up the card's bill first: its last statement, or that there's none yet."}
	case errors.Is(err, cards.ErrNoStatement):
		return &Error{Status: http.StatusConflict, Code: "no_statement", Detail: "The card has no statement yet."}
	case errors.Is(err, cards.ErrStatementFixed):
		return &Error{Status: http.StatusConflict, Code: "statement_fixed",
			Detail: "The statement is fixed already: it was checked against the bank's, or its due date has passed."}
	}
	return nil
}

func (s *server) GetCardBill(ctx context.Context, req api.GetCardBillRequestObject) (api.GetCardBillResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	bill, err := svc.Bill(ctx, sessionFrom(ctx).User.ID, req.AccountId)
	if err != nil {
		return nil, billOrAccountError(err)
	}
	return api.GetCardBill200JSONResponse(toAPIBill(bill)), nil
}

func (s *server) SetupCardBill(ctx context.Context, req api.SetupCardBillRequestObject) (api.SetupCardBillResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	last, err := lastStatement(req.Body.LastStatement.Get())
	if err != nil && !req.Body.LastStatement.IsNull() {
		return nil, err
	}
	bill, err := svc.SetUpBill(ctx, sessionFrom(ctx).User.ID, req.AccountId, last)
	if err != nil {
		return nil, billOrAccountError(err)
	}
	return api.SetupCardBill200JSONResponse(toAPIBill(bill)), nil
}

func (s *server) ConfirmCardBill(ctx context.Context, req api.ConfirmCardBillRequestObject) (api.ConfirmCardBillResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	bill, err := svc.ConfirmBill(ctx, sessionFrom(ctx).User.ID, req.AccountId, amount)
	if err != nil {
		return nil, billOrAccountError(err)
	}
	return api.ConfirmCardBill200JSONResponse(toAPIBill(bill)), nil
}

func billOrAccountError(err error) error {
	if e := billError(err); e != nil {
		return e
	}
	return accountError(err)
}

// lastStatement parses a card's last statement; nil without one.
func lastStatement(l api.CardLastStatement, err error) (*cards.LastStatement, error) {
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(l.Amount)
	if err != nil {
		return nil, err
	}
	paid, err := parseAmount(l.Paid)
	if err != nil {
		return nil, err
	}
	return &cards.LastStatement{Amount: amount, Paid: paid}, nil
}

func apiDate(d calendar.Date) openapi_types.Date { return openapi_types.Date{Time: d.Time(time.UTC)} }

func toAPIBill(b cards.Bill) api.CardBill {
	out := api.CardBill{
		SetUp:             b.SetUp,
		Current:           nullable.NewNullNullable[api.CardStatement](),
		Previous:          nullable.NewNullNullable[api.CardStatement](),
		NextStatementDate: apiDate(b.Next),
	}
	if b.Current != nil {
		out.Current = nullable.NewNullableWithValue(toAPIStatement(*b.Current))
	}
	if b.Previous != nil {
		out.Previous = nullable.NewNullableWithValue(toAPIStatement(*b.Previous))
	}
	return out
}

func toAPIStatement(st cards.Statement) api.CardStatement {
	out := api.CardStatement{
		Id: st.ID, StatementDate: apiDate(st.Date), Cutoff: st.Cutoff.UTC(), DueDate: apiDate(st.Due),
		Amount: st.Amount.StringFixed(money.Places), Minimum: st.Minimum.StringFixed(money.Places),
		Paid: st.Paid.StringFixed(money.Places), Left: st.Left.StringFixed(money.Places),
		MinimumLeft: st.MinimumLeft.StringFixed(money.Places),
		Fixed:       st.Fixed,
		FixedBy:     nullable.NewNullNullable[api.CardStatementFixedBy](),
		FixedAt:     nullable.NewNullNullable[time.Time](),
	}
	if st.Fixed {
		out.FixedBy = nullable.NewNullableWithValue(api.CardStatementFixedBy(st.FixedBy))
		out.FixedAt = nullable.NewNullableWithValue(st.FixedAt.UTC())
	}
	return out
}
