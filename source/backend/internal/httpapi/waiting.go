package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// Counting a purchase in its bucket later (#264).

func fromAPICountLater(c *api.CountLater) (*transactions.CountLater, error) {
	if c == nil {
		return nil, nil
	}
	out := &transactions.CountLater{When: sqlc.WaitingChargeWhen(c.When), CycleID: deref(c.CycleId)}
	if c.Month != nil {
		m, err := time.Parse("2006-01", *c.Month)
		if err != nil {
			return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "The month is YYYY-MM.", Err: err}
		}
		out.Month = m
	}
	switch {
	case out.When == sqlc.WaitingChargeWhenCycle && out.CycleID == "":
		return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "Counting in a later cycle needs the cycle."}
	case out.When == sqlc.WaitingChargeWhenMonth && out.Month.IsZero():
		return nil, &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "Counting in a later month needs the month."}
	}
	return out, nil
}

func toAPIWaitingLines(lines []transactions.WaitingLine) []api.TransactionWaitingLine {
	out := make([]api.TransactionWaitingLine, len(lines))
	for i, l := range lines {
		out[i] = api.TransactionWaitingLine{PurchaseId: l.PurchaseID, BucketId: l.BucketID, Amount: l.Amount.StringFixed(money.Places)}
	}
	return out
}

func dateOrNull(t time.Time) nullable.Nullable[openapi_types.Date] {
	if t.IsZero() {
		return nullable.NewNullNullable[openapi_types.Date]()
	}
	return nullable.NewNullableWithValue(openapi_types.Date{Time: t})
}

func toAPIWaiting(list []transactions.WaitingCharge) []api.WaitingCharge {
	out := make([]api.WaitingCharge, len(list))
	for i, w := range list {
		out[i] = api.WaitingCharge{
			Id: w.ID, BucketId: w.BucketID, When: api.WaitingChargeWhen(w.When), CycleId: nullableString(w.CycleID),
			TakeOn: dateOrNull(w.TakeOn), Amount: w.Part.StringFixed(money.Places), Left: w.Left.StringFixed(money.Places),
			BucketDeleted: w.BucketDeleted,
		}
	}
	return out
}

func (s *server) ListWaitingCharges(ctx context.Context, req api.ListWaitingChargesRequestObject) (api.ListWaitingChargesResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	list, err := svc.Waiting(ctx, sessionFrom(ctx).User.ID, deref(req.Params.AccountId))
	if err != nil {
		return nil, transactionError(err)
	}
	out := make(api.ListWaitingCharges200JSONResponse, len(list))
	for i, w := range list {
		out[i] = api.OpenWaitingCharge{
			Id: w.ID, PurchaseId: w.PurchaseID, BucketId: w.BucketID, AccountId: w.AccountID,
			When: api.WaitingChargeWhen(w.When), CycleId: nullableString(w.CycleID), TakeOn: dateOrNull(w.TakeOn),
			At: w.At.UTC(), Counterparty: w.Counterparty, Left: w.Left.StringFixed(money.Places),
		}
	}
	return out, nil
}

func (s *server) TakeWaitingCharge(ctx context.Context, req api.TakeWaitingChargeRequestObject) (api.TakeWaitingChargeResponseObject, error) {
	svc, err := s.transactionService()
	if err != nil {
		return nil, err
	}
	t, err := svc.Take(ctx, sessionFrom(ctx).User.ID, req.ChargeId)
	if err != nil {
		return nil, transactionError(err)
	}
	return api.TakeWaitingCharge200JSONResponse(toAPITransaction(t)), nil
}
