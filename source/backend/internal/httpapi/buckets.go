package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
)

func (s *server) ListBuckets(ctx context.Context, _ api.ListBucketsRequestObject) (api.ListBucketsResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListBuckets200JSONResponse, len(list))
	for i, b := range list {
		out[i] = toAPIBucket(b)
	}
	return out, nil
}

func (s *server) ListBucketFigures(ctx context.Context, req api.ListBucketFiguresRequestObject) (api.ListBucketFiguresResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	list, err := svc.CycleFigures(ctx, sessionFrom(ctx).User.ID, req.CycleId)
	if errors.Is(err, balance.ErrNotFound) {
		return nil, &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Cycle not found.", Err: err}
	}
	if err != nil {
		return nil, err
	}
	amount := func(d decimal.Decimal) string { return d.StringFixed(money.Places) }
	out := make(api.ListBucketFigures200JSONResponse, len(list))
	for i, f := range list {
		out[i] = api.BucketFigures{
			BucketId:     f.BucketID,
			Start:        amount(f.Start),
			Refills:      amount(f.Refills),
			Income:       amount(f.Income),
			OpeningFunds: amount(f.Opening),
			Adjustments:  amount(f.Adjustments),
			Transfers:    amount(f.Transfers),
			Budget:       amount(f.Budget),
			Used:         amount(f.Used),
			Overflow:     amount(f.Overflow),
			Left:         amount(f.Left),
		}
	}
	return out, nil
}

func (s *server) CreateBucket(ctx context.Context, req api.CreateBucketRequestObject) (api.CreateBucketResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	n := buckets.New{Name: b.Name, SourceAccountID: b.SourceAccountId}
	for _, f := range []struct {
		in  *string
		out *decimal.Decimal
	}{
		{b.RefillAmount, &n.RefillAmount},
		{b.CapMultiplier, &n.CapMultiplier},
		{b.CapAmount, &n.CapAmount},
		{b.OpeningFunds, &n.OpeningFunds},
	} {
		if f.in != nil {
			if *f.out, err = parseAmount(*f.in); err != nil {
				return nil, err
			}
		}
	}
	if b.CapMode != nil {
		n.CapMode = sqlc.BucketCapMode(*b.CapMode)
	}
	if b.KeepFunds != nil {
		n.KeepFunds = *b.KeepFunds
	}
	if b.RefillMode != nil {
		n.RefillMode = sqlc.RefillMode(*b.RefillMode)
	}
	if b.OverflowDestination != nil {
		n.OverflowDestination = sqlc.OverflowDestination(*b.OverflowDestination)
	}
	if b.Priority != nil {
		n.Priority = *b.Priority
	}
	if b.Importance != nil {
		n.Importance = *b.Importance
	}
	if b.Refill != nil {
		n.Refill = *b.Refill
	}
	out, err := svc.Create(ctx, sessionFrom(ctx).User.ID, n)
	if err != nil {
		return nil, bucketError(err)
	}
	return api.CreateBucket201JSONResponse(toAPIBucket(out)), nil
}

func (s *server) GetBucket(ctx context.Context, req api.GetBucketRequestObject) (api.GetBucketResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	b, err := svc.Get(ctx, sessionFrom(ctx).User.ID, req.BucketId)
	if err != nil {
		return nil, bucketError(err)
	}
	return api.GetBucket200JSONResponse(toAPIBucket(b)), nil
}

func (s *server) UpdateBucket(ctx context.Context, req api.UpdateBucketRequestObject) (api.UpdateBucketResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	c := buckets.Changes{
		Name: b.Name, SourceAccountID: b.SourceAccountId,
		KeepFunds: b.KeepFunds, Priority: b.Priority, Importance: b.Importance,
	}
	for _, f := range []struct {
		in  *string
		out **decimal.Decimal
	}{
		{b.RefillAmount, &c.RefillAmount},
		{b.CapMultiplier, &c.CapMultiplier},
		{b.CapAmount, &c.CapAmount},
	} {
		if f.in != nil {
			d, err := parseAmount(*f.in)
			if err != nil {
				return nil, err
			}
			*f.out = &d
		}
	}
	if b.CapMode != nil {
		m := sqlc.BucketCapMode(*b.CapMode)
		c.CapMode = &m
	}
	if b.RefillMode != nil {
		m := sqlc.RefillMode(*b.RefillMode)
		c.RefillMode = &m
	}
	if b.OverflowDestination != nil {
		d := sqlc.OverflowDestination(*b.OverflowDestination)
		c.OverflowDestination = &d
	}
	out, err := svc.Update(ctx, sessionFrom(ctx).User.ID, req.BucketId, c)
	if err != nil {
		return nil, bucketError(err)
	}
	return api.UpdateBucket200JSONResponse(toAPIBucket(out)), nil
}

func (s *server) AdjustBucket(ctx context.Context, req api.AdjustBucketRequestObject) (api.AdjustBucketResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	a := buckets.Adjustment{Mode: buckets.Mode(req.Body.Mode)}
	for _, f := range []struct {
		in  *string
		out **decimal.Decimal
	}{
		{req.Body.TargetFunds, &a.TargetFunds},
		{req.Body.RefillAmount, &a.RefillAmount},
	} {
		if f.in != nil {
			d, err := parseAmount(*f.in)
			if err != nil {
				return nil, err
			}
			*f.out = &d
		}
	}
	out, err := svc.Adjust(ctx, sessionFrom(ctx).User.ID, req.BucketId, a)
	if err != nil {
		return nil, bucketError(err)
	}
	return api.AdjustBucket200JSONResponse(toAPIBucket(out)), nil
}

func (s *server) TransferBucketFunds(ctx context.Context, req api.TransferBucketFundsRequestObject) (api.TransferBucketFundsResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	from, to, err := svc.Transfer(ctx, sessionFrom(ctx).User.ID, req.BucketId, buckets.Transfer{
		To: req.Body.ToBucketId, Mode: buckets.Mode(req.Body.Mode), Amount: amount,
	})
	if err != nil {
		return nil, bucketError(err)
	}
	return api.TransferBucketFunds200JSONResponse{From: toAPIBucket(from), To: toAPIBucket(to)}, nil
}

func (s *server) SetRefillAmounts(ctx context.Context, req api.SetRefillAmountsRequestObject) (api.SetRefillAmountsResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	items := make([]buckets.RefillAmount, len(req.Body.Items))
	for i, it := range req.Body.Items {
		items[i].BucketID = it.BucketId
		if items[i].Amount, err = parseAmount(it.RefillAmount); err != nil {
			return nil, err
		}
	}
	list, err := svc.SetRefillAmounts(ctx, sessionFrom(ctx).User.ID, items)
	if err != nil {
		return nil, bucketError(err)
	}
	out := api.SetRefillAmounts200JSONResponse{Items: make([]api.Bucket, len(list))}
	for i, b := range list {
		out.Items[i] = toAPIBucket(b)
	}
	return out, nil
}

func (s *server) DeleteBucket(ctx context.Context, req api.DeleteBucketRequestObject) (api.DeleteBucketResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	if err := svc.Delete(ctx, sessionFrom(ctx).User.ID, req.BucketId); err != nil {
		return nil, bucketError(err)
	}
	return api.DeleteBucket204Response{}, nil
}

func (s *server) RefillBucket(ctx context.Context, req api.RefillBucketRequestObject) (api.RefillBucketResponseObject, error) {
	svc, err := s.bucketService()
	if err != nil {
		return nil, err
	}
	if s.refills == nil {
		return nil, NewError(http.StatusServiceUnavailable, "refills_unavailable", "")
	}
	userID := sessionFrom(ctx).User.ID
	if err := s.refills.Manual(ctx, userID, req.BucketId); err != nil {
		return nil, refillError(err)
	}
	out, err := svc.Get(ctx, userID, req.BucketId)
	if err != nil {
		return nil, bucketError(err)
	}
	return api.RefillBucket200JSONResponse(toAPIBucket(out)), nil
}

// refillError maps errors from the refill routines to problems.
func refillError(err error) error {
	switch {
	case errors.Is(err, refill.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Bucket not found.", Err: err}
	case errors.Is(err, refill.ErrAlreadyRefilled):
		return &Error{Status: http.StatusConflict, Code: "already_refilled", Detail: "The bucket has already been refilled in this cycle."}
	case errors.Is(err, refill.ErrWrongMode):
		return &Error{Status: http.StatusConflict, Code: "wrong_refill_mode", Detail: "Only buckets with the manual refill mode can be refilled by hand."}
	case errors.Is(err, refill.ErrUnavailable):
		return &Error{Status: http.StatusConflict, Code: "refill_unavailable",
			Detail: "Only income in the active cycle can trigger a refill.", Err: err}
	}
	return ledgerError(err)
}

func (s *server) bucketService() (*buckets.Service, error) {
	if s.buckets == nil {
		return nil, NewError(http.StatusServiceUnavailable, "buckets_unavailable", "")
	}
	return s.buckets, nil
}

// bucketError maps errors from the buckets service to problems.
func bucketError(err error) error {
	switch {
	case errors.Is(err, buckets.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Bucket not found.", Err: err}
	case errors.Is(err, buckets.ErrNameTaken):
		return &Error{Status: http.StatusConflict, Code: "name_taken", Detail: "You already have a bucket with this name."}
	case errors.Is(err, buckets.ErrCurrencyMismatch):
		return &Error{Status: http.StatusBadRequest, Code: "currency_mismatch",
			Detail: "A bucket can only move to an account in the same currency."}
	case errors.Is(err, buckets.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, buckets.ErrInvalid), Err: err}
	case errors.Is(err, buckets.ErrNoChange):
		return &Error{Status: http.StatusBadRequest, Code: "no_change", Detail: "Nothing would change.", Err: err}
	}
	return ledgerError(err)
}

// ledgerError maps the ledger's errors about cycles to problems. The services
// check everything else first, so other ledger errors are races, e.g. an
// account deleted meanwhile.
func ledgerError(err error) error {
	switch {
	case errors.Is(err, ledger.ErrNoActiveCycle):
		return &Error{Status: http.StatusConflict, Code: "no_active_cycle",
			Detail: "Bucket transactions need an active cycle. Start a cycle first.", Err: err}
	case errors.Is(err, ledger.ErrOutsideCycle):
		return &Error{Status: http.StatusConflict, Code: "cycle_overdue",
			Detail: "The active cycle's end date has passed. Extend or end the cycle first.", Err: err}
	case errors.Is(err, ledger.ErrInvalid), errors.Is(err, ledger.ErrNotFound):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: "The transaction couldn't be recorded. Reload and try again.", Err: err}
	}
	return err
}

func toAPIBucket(b buckets.Bucket) api.Bucket {
	out := api.Bucket{
		Id:                    b.ID,
		Name:                  b.Name,
		SourceAccountId:       b.SourceAccountID,
		Currency:              b.Currency,
		RefillAmount:          b.RefillAmount.StringFixed(money.Places),
		CapMode:               api.CapMode(b.CapMode),
		CapMultiplier:         nullable.NewNullNullable[string](),
		CapAmount:             nullable.NewNullNullable[string](),
		Capacity:              b.Capacity.StringFixed(money.Places),
		TargetFunds:           b.TargetFunds.StringFixed(money.Places),
		CurrentAvailableFunds: b.Caf.StringFixed(money.Places),
		KeepFunds:             b.KeepFunds,
		RefillMode:            api.RefillMode(b.RefillMode),
		OverflowDestination:   api.OverflowDestination(b.OverflowDestination),
		Priority:              b.Priority,
		Importance:            int(b.Importance),
		Refilled:              b.Refilled,
		CreatedAt:             b.CreatedAt.UTC(),
	}
	if b.CapMultiplier.Valid {
		out.CapMultiplier.Set(b.CapMultiplier.Decimal.StringFixed(2))
	}
	if b.CapAmount.Valid {
		out.CapAmount.Set(b.CapAmount.Decimal.StringFixed(money.Places))
	}
	return out
}
