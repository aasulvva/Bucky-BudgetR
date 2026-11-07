package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
)

// server implements the operations in api/openapi.yaml. Gate has already
// checked sessions and validated requests against the spec.
type server struct {
	db           Pinger
	auth         *auth.Service
	accounts     *accounts.Service
	cycles       *cycles.Service
	buckets      *buckets.Service
	transactions *transactions.Service
	refills      *refill.Service
}

var _ api.StrictServerInterface = (*server)(nil)

func (s *server) GetHealthz(context.Context, api.GetHealthzRequestObject) (api.GetHealthzResponseObject, error) {
	return api.GetHealthz200JSONResponse{Status: api.Ok}, nil
}

func (s *server) GetReadyz(ctx context.Context, _ api.GetReadyzRequestObject) (api.GetReadyzResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		return nil, &Error{
			Status: http.StatusServiceUnavailable,
			Code:   "database_unavailable",
			Detail: "The database is not reachable.",
			Err:    err,
		}
	}
	return api.GetReadyz200JSONResponse{Status: api.Ok}, nil
}

func (s *server) Login(ctx context.Context, req api.LoginRequestObject) (api.LoginResponseObject, error) {
	if s.auth == nil {
		return nil, NewError(http.StatusServiceUnavailable, "auth_unavailable", "")
	}
	sess, token, err := s.auth.Login(ctx, req.Body.Username, req.Body.Password, clientFrom(ctx))
	if err != nil {
		return nil, authError(err, http.StatusUnauthorized, "invalid_credentials", "Wrong username or password.")
	}
	user, err := toAPIUser(sess.User)
	if err != nil {
		return nil, err
	}
	cookie := sessionCookie(token, s.auth.MaxAge()).String()
	return api.Login200JSONResponse{Body: user, Headers: api.Login200ResponseHeaders{SetCookie: &cookie}}, nil
}

func (s *server) CheckPasswordLink(ctx context.Context, req api.CheckPasswordLinkRequestObject) (api.CheckPasswordLinkResponseObject, error) {
	info, err := s.auth.CheckLink(ctx, req.Body.Token)
	if err != nil {
		return nil, linkError(err)
	}
	return api.CheckPasswordLink200JSONResponse{
		Username:  info.Username,
		Purpose:   api.PasswordLinkInfoPurpose(info.Purpose),
		ExpiresAt: info.ExpiresAt,
	}, nil
}

func (s *server) UsePasswordLink(ctx context.Context, req api.UsePasswordLinkRequestObject) (api.UsePasswordLinkResponseObject, error) {
	sess, token, err := s.auth.UseLink(ctx, req.Body.Token, req.Body.NewPassword, clientFrom(ctx))
	if err != nil {
		return nil, linkError(err)
	}
	user, err := toAPIUser(sess.User)
	if err != nil {
		return nil, err
	}
	cookie := sessionCookie(token, s.auth.MaxAge()).String()
	return api.UsePasswordLink200JSONResponse{Body: user, Headers: api.UsePasswordLink200ResponseHeaders{SetCookie: &cookie}}, nil
}

func linkError(err error) error {
	if errors.Is(err, auth.ErrInvalidLink) {
		return &Error{Status: http.StatusNotFound, Code: "invalid_link",
			Detail: "This link doesn't work: it has been used, has expired or was replaced. Ask an admin for a new one."}
	}
	return authError(err, http.StatusBadRequest, "invalid_request", "")
}

func (s *server) Logout(ctx context.Context, _ api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	if err := s.auth.Logout(ctx, sessionFrom(ctx)); err != nil {
		return nil, err
	}
	cookie := clearedSessionCookie().String()
	return api.Logout204Response{Headers: api.Logout204ResponseHeaders{SetCookie: &cookie}}, nil
}

func (s *server) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	user, err := toAPIUser(sessionFrom(ctx).User)
	if err != nil {
		return nil, err
	}
	return api.GetMe200JSONResponse(user), nil
}

func (s *server) ChangePassword(ctx context.Context, req api.ChangePasswordRequestObject) (api.ChangePasswordResponseObject, error) {
	err := s.auth.ChangePassword(ctx, sessionFrom(ctx), req.Body.CurrentPassword, req.Body.NewPassword)
	if err != nil {
		// A wrong current password is a 400, not a 401: the session is fine.
		return nil, authError(err, http.StatusBadRequest, "wrong_password", "The current password is wrong.")
	}
	return api.ChangePassword204Response{}, nil
}

func (s *server) UpdatePreferences(ctx context.Context, req api.UpdatePreferencesRequestObject) (api.UpdatePreferencesResponseObject, error) {
	user := sessionFrom(ctx).User
	current, err := toAPIPreferences(user.Preferences)
	if err != nil {
		return nil, err
	}
	if err := checkCycleRule(current, *req.Body); err != nil {
		return nil, err
	}
	if err := checkDashboard(*req.Body); err != nil {
		return nil, err
	}
	patch, err := json.Marshal(req.Body)
	if err != nil {
		return nil, err
	}
	stored, err := s.auth.UpdatePreferences(ctx, user.ID, patch)
	if err != nil {
		return nil, err
	}
	// A new rule or zone replans the cycles the rule planned (#72).
	if s.cycles != nil && (req.Body.CycleRule.IsSpecified() || req.Body.TimeZone.IsSpecified()) {
		if err := s.cycles.Replan(ctx, user.ID); err != nil {
			return nil, err
		}
	}
	prefs, err := toAPIPreferences(stored)
	if err != nil {
		return nil, err
	}
	return api.UpdatePreferences200JSONResponse(prefs), nil
}

// checkCycleRule checks a preferences patch: a time zone must exist, and a
// cycle rule needs one.
func checkCycleRule(current, patch api.Preferences) error {
	invalid := func(detail string) error {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: detail}
	}
	zone, _ := current.TimeZone.Get()
	if patch.TimeZone.IsSpecified() {
		zone, _ = patch.TimeZone.Get()
		if !patch.TimeZone.IsNull() {
			if _, err := time.LoadLocation(zone); err != nil || zone == "" || zone == "Local" {
				return invalid("Unknown time zone " + strconv.Quote(zone) + ".")
			}
		}
	}
	rule := current.CycleRule.IsSpecified() && !current.CycleRule.IsNull()
	if patch.CycleRule.IsSpecified() {
		rule = !patch.CycleRule.IsNull()
	}
	if rule && zone == "" {
		return invalid("A cycle rule needs a time zone.")
	}
	return nil
}

// checkDashboard checks a preferences patch's Dashboard layout (#37): widget
// ids are unique, a custom title isn't blank, and a widget only carries its
// own type's settings.
func checkDashboard(patch api.Preferences) error {
	dashboard, err := patch.Dashboard.Get()
	if err != nil {
		return nil // Not given, or null.
	}
	widgets, err := dashboard.Widgets.Get()
	if err != nil {
		return nil
	}
	invalid := func(detail string) error {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: detail}
	}
	seen := make(map[string]bool, len(widgets))
	for _, w := range widgets {
		if seen[w.Id] {
			return invalid("Widget id " + strconv.Quote(w.Id) + " is used more than once.")
		}
		seen[w.Id] = true
		if title, err := w.Title.Get(); err == nil && strings.TrimSpace(title) == "" {
			return invalid("Widget " + strconv.Quote(w.Id) + " has a blank title.")
		}
		settings := map[api.DashboardWidgetType]bool{
			api.DashboardWidgetTypeCycle:              w.Cycle != nil,
			api.DashboardWidgetTypeAccounts:           w.Accounts != nil,
			api.DashboardWidgetTypeBucketStatus:       w.BucketStatus != nil,
			api.DashboardWidgetTypeRecentTransactions: w.RecentTransactions != nil,
			api.DashboardWidgetTypeInOut:              w.InOut != nil,
		}
		for t, given := range settings {
			if given && t != w.Type {
				return invalid("Widget " + strconv.Quote(w.Id) + " is a " + string(w.Type) + " widget but has " + string(t) + " settings.")
			}
		}
	}
	return nil
}

// authError maps auth errors to problems. A wrong password gets the given
// status and code.
func authError(err error, wrongStatus int, wrongCode, wrongDetail string) error {
	var limited *auth.RateLimitedError
	switch {
	case errors.Is(err, auth.ErrInvalidCredentials):
		return &Error{Status: wrongStatus, Code: wrongCode, Detail: wrongDetail}
	case errors.As(err, &limited):
		secs := int(math.Ceil(limited.RetryAfter.Seconds()))
		return &Error{
			Status: http.StatusTooManyRequests,
			Code:   "too_many_attempts",
			Detail: "Too many failed attempts. Try again in " + strconv.Itoa(secs) + " seconds.",
			Header: http.Header{"Retry-After": {strconv.Itoa(secs)}},
		}
	case errors.Is(err, auth.ErrWeakPassword):
		detail := strings.TrimPrefix(err.Error(), auth.ErrWeakPassword.Error()+": ")
		return &Error{Status: http.StatusBadRequest, Code: "weak_password", Detail: capitalize(detail) + "."}
	}
	return err
}

func toAPIUser(u sqlc.User) (api.User, error) {
	prefs, err := toAPIPreferences(u.Preferences)
	if err != nil {
		return api.User{}, err
	}
	return api.User{
		Id:                 u.ID,
		Username:           u.Username,
		Admin:              u.Admin,
		MustChangePassword: u.MustChangePassword,
		Preferences:        prefs,
	}, nil
}

func toAPIPreferences(stored []byte) (api.Preferences, error) {
	var p api.Preferences
	if err := json.Unmarshal(stored, &p); err != nil {
		return api.Preferences{}, err
	}
	return p, nil
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
