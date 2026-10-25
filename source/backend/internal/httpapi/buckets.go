package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
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
