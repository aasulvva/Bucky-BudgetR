package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// BSU accounts (#214): the history setup, and the admins' deposit rules.

func (s *server) GetBsuHistory(ctx context.Context, req api.GetBsuHistoryRequestObject) (api.GetBsuHistoryResponseObject, error) {
	svc, err := s.bsuService()
	if err != nil {
		return nil, err
	}
	h, err := svc.History(ctx, sessionFrom(ctx).User.ID, req.AccountId)
	if err != nil {
		return nil, bsuError(err)
	}
	out := api.GetBsuHistory200JSONResponse{
		LatestOpenedYear: h.LatestOpenedYear,
		Opening:          h.Opening.StringFixed(money.Places),
		Balance:          h.Balance.StringFixed(money.Places),
		SetUpAt:          nullable.NewNullNullable[time.Time](),
		Rules:            toAPIBSURules(h.Rules),
	}
	if !h.SetUpAt.IsZero() {
		out.SetUpAt = nullable.NewNullableWithValue(h.SetUpAt.UTC())
	}
	for _, y := range h.Years {
		out.Years = append(out.Years, struct {
			Recorded api.BSUSums `json:"recorded"`
			Year     int         `json:"year"`
		}{Year: y.Year, Recorded: api.BSUSums{
			Deposits:    y.Recorded.Deposits.StringFixed(money.Places),
			Interest:    y.Recorded.Interest.StringFixed(money.Places),
			Withdrawals: y.Recorded.Withdrawals.StringFixed(money.Places),
		}})
	}
	return out, nil
}

func (s *server) SetUpBsuHistory(ctx context.Context, req api.SetUpBsuHistoryRequestObject) (api.SetUpBsuHistoryResponseObject, error) {
	svc, err := s.bsuService()
	if err != nil {
		return nil, err
	}
	accountsSvc, err := s.accountService()
	if err != nil {
		return nil, err
	}
	b := req.Body
	in := bsu.SetUpInput{OpenedYear: b.OpenedYear}
	if b.InterestCounterparty != nil {
		in.InterestCounterparty = *b.InterestCounterparty
	}
	if in.Balance, err = parseAmount(b.Balance); err != nil {
		return nil, err
	}
	for _, y := range b.Years {
		yi := bsu.YearInput{Year: y.Year}
		if yi.Deposits, err = parseAmount(y.Deposits); err != nil {
			return nil, err
		}
		if yi.Interest, err = parseAmount(y.Interest); err != nil {
			return nil, err
		}
		if yi.Withdrawals, err = parseAmount(y.Withdrawals); err != nil {
			return nil, err
		}
		in.Years = append(in.Years, yi)
	}
	userID := sessionFrom(ctx).User.ID
	if err := svc.SetUp(ctx, userID, req.AccountId, in); err != nil {
		return nil, bsuError(err)
	}
	a, err := accountsSvc.Get(ctx, userID, req.AccountId)
	if err != nil {
		return nil, accountError(err)
	}
	return api.SetUpBsuHistory200JSONResponse(toAPIAccount(a)), nil
}

func (s *server) ListBsuRules(ctx context.Context, _ api.ListBsuRulesRequestObject) (api.ListBsuRulesResponseObject, error) {
	svc, err := s.bsuService()
	if err != nil {
		return nil, err
	}
	list, err := svc.Rules(ctx)
	if err != nil {
		return nil, err
	}
	return api.ListBsuRules200JSONResponse(toAPIBSURules(list)), nil
}

func (s *server) SetBsuRule(ctx context.Context, req api.SetBsuRuleRequestObject) (api.SetBsuRuleResponseObject, error) {
	svc, err := s.bsuService()
	if err != nil {
		return nil, err
	}
	r := bsu.Rule{FromYear: req.Year}
	if r.YearlyLimit, err = parseAmount(req.Body.YearlyLimit); err != nil {
		return nil, err
	}
	if r.TotalLimit, err = parseAmount(req.Body.TotalLimit); err != nil {
		return nil, err
	}
	before, after, err := svc.SetRule(ctx, sessionFrom(ctx).User.ID, r)
	if err != nil {
		return nil, bsuError(err)
	}
	// The limits are the law's, not anyone's money, so the audit entry may
	// hold them.
	if before == nil || !before.YearlyLimit.Equal(after.YearlyLimit) || !before.TotalLimit.Equal(after.TotalLimit) {
		attrs := []any{slog.Int("from_year", after.FromYear)}
		if before != nil {
			attrs = append(attrs, ruleGroup("old", *before))
		}
		s.audit(ctx, "BSU rule changed", "bsu.rule_changed", append(attrs, ruleGroup("new", after))...)
	}
	return api.SetBsuRule200JSONResponse(toAPIBSURule(after)), nil
}

func (s *server) DeleteBsuRule(ctx context.Context, req api.DeleteBsuRuleRequestObject) (api.DeleteBsuRuleResponseObject, error) {
	svc, err := s.bsuService()
	if err != nil {
		return nil, err
	}
	old, err := svc.DeleteRule(ctx, req.Year)
	if err != nil {
		return nil, bsuError(err)
	}
	s.audit(ctx, "BSU rule deleted", "bsu.rule_deleted", slog.Int("from_year", old.FromYear), ruleGroup("old", old))
	return api.DeleteBsuRule204Response{}, nil
}

func ruleGroup(name string, r bsu.Rule) slog.Attr {
	return slog.Group(name, slog.String("yearly_limit", r.YearlyLimit.StringFixed(money.Places)),
		slog.String("total_limit", r.TotalLimit.StringFixed(money.Places)))
}

func toAPIBSURules(list []bsu.Rule) []api.BSURule {
	out := make([]api.BSURule, len(list))
	for i, r := range list {
		out[i] = toAPIBSURule(r)
	}
	return out
}

func toAPIBSURule(r bsu.Rule) api.BSURule {
	return api.BSURule{
		FromYear: r.FromYear, YearlyLimit: r.YearlyLimit.StringFixed(money.Places),
		TotalLimit: r.TotalLimit.StringFixed(money.Places), ModifiedAt: r.ModifiedAt.UTC(),
	}
}

func toAPIBSUStatus(st bsu.Status) api.BSUStatus {
	out := api.BSUStatus{
		Year: st.Year, YearlyLimit: st.YearlyLimit.StringFixed(money.Places), TotalLimit: st.TotalLimit.StringFixed(money.Places),
		DepositedYear: st.DepositedYear.StringFixed(money.Places), DepositedTotal: st.DepositedTotal.StringFixed(money.Places),
		LeftYear: st.LeftYear.StringFixed(money.Places), LeftTotal: st.LeftTotal.StringFixed(money.Places),
		Over: st.Over, Locked: st.Locked, OpenedYear: nullable.NewNullNullable[int](),
	}
	if st.OpenedYear != 0 {
		out.OpenedYear = nullable.NewNullableWithValue(st.OpenedYear)
	}
	return out
}

func (s *server) bsuService() (*bsu.Service, error) {
	if s.bsu == nil {
		return nil, NewError(http.StatusServiceUnavailable, "bsu_unavailable", "")
	}
	return s.bsu, nil
}

// bsuError maps errors from the bsu package to problems, for the history
// setup, the rules and the checks on transactions.
func bsuError(err error) error {
	var over *bsu.OverLimitError
	switch {
	case errors.As(err, &over):
		return &Error{Status: http.StatusConflict, Code: "bsu_over_limit",
			Detail: "This takes the BSU account over its deposit limit: " + over.LeftYear.StringFixed(money.Places) +
				" may still be deposited in " + strconv.Itoa(over.Year) + ", and " +
				over.LeftTotal.StringFixed(money.Places) + " in total. Confirm to record it anyway."}
	case errors.Is(err, bsu.ErrWithdrawal):
		return &Error{Status: http.StatusConflict, Code: "bsu_withdrawal",
			Detail: "This takes money out of a BSU account, which can end its tax deduction. Confirm to record it anyway."}
	case errors.Is(err, bsu.ErrLocked):
		return &Error{Status: http.StatusConflict, Code: "bsu_locked",
			Detail: "The BSU account is locked until its history is set up. Set it up on the Accounts screen first."}
	case errors.Is(err, bsu.ErrNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Not found.", Err: err}
	case errors.Is(err, bsu.ErrLastRule):
		return &Error{Status: http.StatusConflict, Code: "last_rule", Detail: "The last BSU rule can't be deleted."}
	case errors.Is(err, bsu.ErrSetUp):
		return &Error{Status: http.StatusConflict, Code: "bsu_set_up", Detail: "The account's BSU history is set up already."}
	case errors.Is(err, bsu.ErrNotBSU):
		return &Error{Status: http.StatusBadRequest, Code: "not_bsu",
			Detail: "Only a BSU account in NOK has a BSU history. Change its type, or delete it."}
	case errors.Is(err, bsu.ErrInvalid):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: invalidDetail(err, bsu.ErrInvalid), Err: err}
	}
	return err
}
