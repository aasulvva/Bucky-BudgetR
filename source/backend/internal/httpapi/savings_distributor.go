package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
)

// The savings distributor and its rules (#232).

func (s *server) GetSavingsDistributor(ctx context.Context, _ api.GetSavingsDistributorRequestObject) (api.GetSavingsDistributorResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	d, err := svc.Distributor(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	return api.GetSavingsDistributor200JSONResponse(toAPIDistributor(d)), nil
}

func (s *server) UpdateSavingsDistributor(ctx context.Context, req api.UpdateSavingsDistributorRequestObject) (api.UpdateSavingsDistributorResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	var minAmount decimal.NullDecimal
	if req.Body.MinAmount != nil {
		d, err := parseAmount(*req.Body.MinAmount)
		if err != nil {
			return nil, err
		}
		minAmount = decimal.NewNullDecimal(d)
	}
	d, err := svc.UpdateDistributor(ctx, sessionFrom(ctx).User.ID, sqlc.SavingsHoldMode(req.Body.HoldMode), minAmount)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.UpdateSavingsDistributor200JSONResponse(toAPIDistributor(d)), nil
}

func (s *server) AddToSavingsDistributor(ctx context.Context, req api.AddToSavingsDistributorRequestObject) (api.AddToSavingsDistributorResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	d, split, err := svc.AddToDistributor(ctx, sessionFrom(ctx).User.ID, req.Body.AccountId, amount)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.AddToSavingsDistributor200JSONResponse(toAPIDistribution(d, split)), nil
}

func (s *server) DistributeSavings(ctx context.Context, req api.DistributeSavingsRequestObject) (api.DistributeSavingsResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	account := ""
	if req.Body != nil && req.Body.AccountId != nil {
		account = *req.Body.AccountId
	}
	d, split, err := svc.Distribute(ctx, sessionFrom(ctx).User.ID, account)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.DistributeSavings200JSONResponse(toAPIDistribution(d, split)), nil
}

func (s *server) ClearSavingsDistributor(ctx context.Context, req api.ClearSavingsDistributorRequestObject) (api.ClearSavingsDistributorResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Body.Amount)
	if err != nil {
		return nil, err
	}
	d, err := svc.ClearDistributor(ctx, sessionFrom(ctx).User.ID, req.Body.AccountId, amount)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.ClearSavingsDistributor200JSONResponse(toAPIDistributor(d)), nil
}

func (s *server) PreviewSavingsDistribution(ctx context.Context, req api.PreviewSavingsDistributionRequestObject) (api.PreviewSavingsDistributionResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	amount, err := parseAmount(req.Params.Amount)
	if err != nil {
		return nil, err
	}
	p, err := svc.Preview(ctx, sessionFrom(ctx).User.ID, req.Params.AccountId, amount)
	if err != nil {
		return nil, savingsError(err)
	}
	out := api.PreviewSavingsDistribution200JSONResponse{
		Left:   p.Left.StringFixed(money.Places),
		Shares: make([]api.SavingsShare, len(p.Shares)),
	}
	for i, sh := range p.Shares {
		out.Shares[i] = api.SavingsShare{TargetId: sh.TargetID, Amount: sh.Amount.StringFixed(money.Places), IntoBucket: sh.IntoBucket}
	}
	return out, nil
}

func (s *server) ListSavingsRules(ctx context.Context, _ api.ListSavingsRulesRequestObject) (api.ListSavingsRulesResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	rules, err := svc.ListRules(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListSavingsRules200JSONResponse, len(rules))
	for i, r := range rules {
		out[i] = toAPIRule(r)
	}
	return out, nil
}

func (s *server) CreateSavingsRule(ctx context.Context, req api.CreateSavingsRuleRequestObject) (api.CreateSavingsRuleResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	in, err := ruleInput(b.From, b.To, b.Priority, b.PastGoal)
	if err != nil {
		return nil, err
	}
	r, err := svc.CreateRule(ctx, sessionFrom(ctx).User.ID, b.TargetId, in)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.CreateSavingsRule201JSONResponse(toAPIRule(r)), nil
}

func (s *server) UpdateSavingsRule(ctx context.Context, req api.UpdateSavingsRuleRequestObject) (api.UpdateSavingsRuleResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	in, err := ruleInput(b.From, b.To, b.Priority, b.PastGoal)
	if err != nil {
		return nil, err
	}
	r, err := svc.UpdateRule(ctx, sessionFrom(ctx).User.ID, req.RuleId, in)
	if err != nil {
		return nil, savingsError(err)
	}
	return api.UpdateSavingsRule200JSONResponse(toAPIRule(r)), nil
}

func (s *server) DeleteSavingsRule(ctx context.Context, req api.DeleteSavingsRuleRequestObject) (api.DeleteSavingsRuleResponseObject, error) {
	svc, err := s.savingsService()
	if err != nil {
		return nil, err
	}
	if err := svc.DeleteRule(ctx, sessionFrom(ctx).User.ID, req.RuleId); err != nil {
		return nil, savingsError(err)
	}
	return api.DeleteSavingsRule204Response{}, nil
}

func ruleInput(from api.Amount, to nullable.Nullable[api.Amount], priority int, pastGoal *bool) (savings.RuleInput, error) {
	in := savings.RuleInput{Priority: priority, PastGoal: pastGoal != nil && *pastGoal}
	var err error
	if in.From, err = parseAmount(from); err != nil {
		return savings.RuleInput{}, err
	}
	if v, e := to.Get(); e == nil {
		d, err := parseAmount(v)
		if err != nil {
			return savings.RuleInput{}, err
		}
		in.To = decimal.NewNullDecimal(d)
	}
	return in, nil
}

// distributorError maps the rule errors, then savingsError's.
func distributorError(err error) error {
	if e := cardError(err); e != nil {
		return e
	}
	switch {
	case errors.Is(err, savings.ErrRuleOverlap):
		return &Error{Status: http.StatusConflict, Code: "rule_overlap", Detail: capitalize(err.Error()) + "."}
	case errors.Is(err, savings.ErrTooManyRules):
		return &Error{Status: http.StatusConflict, Code: "too_many_rules", Detail: capitalize(err.Error()) + "."}
	}
	return nil
}

func toAPIDistributor(d savings.Distributor) api.SavingsDistributor {
	out := api.SavingsDistributor{
		Id:        nullable.NewNullNullable[api.SavingsHolderId](),
		HoldMode:  api.SavingsHoldMode(d.HoldMode),
		MinAmount: nullable.NewNullNullable[api.Amount](),
		Held:      make([]api.SavingsHeld, len(d.Held)),
	}
	if d.ID != "" {
		out.Id.Set(d.ID)
	}
	if d.MinAmount.Valid {
		out.MinAmount.Set(d.MinAmount.Decimal.StringFixed(money.Places))
	}
	for i, h := range d.Held {
		out.Held[i] = api.SavingsHeld{
			AccountId: h.AccountID, Amount: h.Amount.StringFixed(money.Places), Covered: h.Covered.StringFixed(money.Places),
		}
	}
	return out
}

func toAPIDistribution(d savings.Distributor, split []string) api.SavingsDistribution {
	if split == nil {
		split = []string{}
	}
	return api.SavingsDistribution{Distributor: toAPIDistributor(d), Distributed: split}
}

func toAPIRule(r savings.SavingsRule) api.SavingsRule {
	out := api.SavingsRule{
		Id: r.ID, TargetId: r.TargetID, From: r.From.StringFixed(money.Places),
		To: nullable.NewNullNullable[api.Amount](), Priority: r.Priority, PastGoal: r.PastGoal,
	}
	if r.To.Valid {
		out.To.Set(r.To.Decimal.StringFixed(money.Places))
	}
	return out
}
