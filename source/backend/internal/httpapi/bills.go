package httpapi

// A credit card's bill (#262, spec §2.2).

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/calendar"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
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

func (s *server) FinalizeCardBill(ctx context.Context, req api.FinalizeCardBillRequestObject) (api.FinalizeCardBillResponseObject, error) {
	svc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	f := accounts.Finalize{Amount: amount}
	if req.Body.Payment.IsSpecified() && !req.Body.Payment.IsNull() {
		p := req.Body.Payment.MustGet()
		pay := accounts.Payment{
			Rule: sqlc.CardPayRule(p.Rule), AccountID: p.AccountId, Mode: sqlc.ScheduleMode(p.Mode),
			BSUConfirmed: deref(p.BsuConfirmed), LimitConfirmed: deref(p.LimitConfirmed),
		}
		if p.Amount != nil {
			if pay.Amount, err = parseAmount(*p.Amount); err != nil {
				return nil, err
			}
		}
		if p.At != nil {
			pay.At = *p.At
		}
		f.Payment = &pay
	}
	if d := req.Body.Difference; d != nil {
		f.Difference = &accounts.Difference{Tag: string(d.Tag), Counterparty: d.Counterparty}
	}
	done, err := svc.FinalizeBill(ctx, sessionFrom(ctx).User.ID, req.AccountId, f)
	if err != nil {
		return nil, finalizeError(err)
	}
	out := api.CardBillFinalized{
		Bill:          toAPIBill(done.Bill),
		ScheduleId:    nullable.NewNullNullable[api.ScheduleId](),
		TransactionId: nullable.NewNullNullable[api.TransactionId](),
	}
	if done.ScheduleID != "" {
		out.ScheduleId.Set(done.ScheduleID)
	}
	if done.TransactionID != "" {
		out.TransactionId.Set(done.TransactionID)
	}
	return api.FinalizeCardBill200JSONResponse(out), nil
}

// finalizeError maps finalizing's errors: the bill's and the account's, then
// the payment's, as a transaction's or a schedule's.
func finalizeError(err error) error {
	if e := billError(err); e != nil {
		return e
	}
	if errors.Is(err, accounts.ErrInvalid) || errors.Is(err, accounts.ErrNotFound) {
		return accountError(err)
	}
	return scheduleError(err)
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
	out.Payment = nullable.NewNullNullable[api.CardBillPayment]()
	if p := b.Payment; p != nil {
		reason := nullable.NewNullNullable[string]()
		if p.Reason != "" {
			reason.Set(p.Reason)
		}
		out.Payment.Set(api.CardBillPayment{
			ScheduleId: p.ScheduleID, Rule: api.CardPayRule(p.Rule), Amount: p.Amount.StringFixed(money.Places),
			AccountId: p.AccountID, At: p.At.UTC(), Mode: api.ScheduleMode(p.Mode),
			State: api.CardBillPaymentState(p.State), Reason: reason,
		})
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
