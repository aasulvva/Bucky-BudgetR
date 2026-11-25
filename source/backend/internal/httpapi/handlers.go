package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/bsu"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/logging"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/pdf"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/planned"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/savings"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

// server implements the operations in api/openapi.yaml. Gate has already
// checked sessions and validated requests against the spec.
type server struct {
	db            Pinger
	auth          *auth.Service
	accounts      *accounts.Service
	cycles        *cycles.Service
	buckets       *buckets.Service
	savings       *savings.Service
	bsu           *bsu.Service
	transactions  *transactions.Service
	refills       *refill.Service
	schedules     *schedules.Service
	planned       *planned.Service
	notifications *notifications.Service
	logs          *logging.Service
	userData      *userdata.Service
	pdf           pdf.Renderer
	logger        *slog.Logger
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
	if err := checkSavedModules(*req.Body); err != nil {
		return nil, err
	}
	if err := checkReportTemplates(*req.Body); err != nil {
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

// checkDashboard checks a preferences patch's Dashboard layouts (#37, #99):
// in each, widget ids are unique, a custom title isn't blank, and a widget
// only carries its own type's settings.
func checkDashboard(patch api.Preferences) error {
	dashboard, err := patch.Dashboard.Get()
	if err != nil {
		return nil // Not given, or null.
	}
	for _, list := range []nullable.Nullable[[]api.DashboardWidget]{dashboard.Widgets, dashboard.MobileWidgets} {
		widgets, err := list.Get()
		if err != nil {
			continue // Not given, or null.
		}
		if err := checkWidgets(widgets); err != nil {
			return err
		}
	}
	return nil
}

// checkWidgets checks one layout's widgets: unique ids, no blank titles,
// and only the settings of each widget's own type.
func checkWidgets(widgets []api.DashboardWidget) error {
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
			api.DashboardWidgetTypeModule:             w.Module != nil,
			api.DashboardWidgetTypeScheduled:          w.Scheduled != nil,
			api.DashboardWidgetTypeSavings:            w.Savings != nil,
			api.DashboardWidgetTypeSavingsTransfer:    w.SavingsTransfer != nil,
		}
		for t, given := range settings {
			if given && t != w.Type {
				return invalid("Widget " + strconv.Quote(w.Id) + " is a " + string(w.Type) + " widget but has " + string(t) + " settings.")
			}
		}
	}
	return nil
}

// checkSavedModules checks a preferences patch's saved modules (#201):
// ids are unique, names aren't blank, and each module has its type's
// settings and isn't a section.
func checkSavedModules(patch api.Preferences) error {
	saved, err := patch.SavedModules.Get()
	if err != nil {
		return nil // Not given, or null.
	}
	bad := func(detail string) error {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: detail}
	}
	seen := make(map[string]bool, len(saved))
	for _, m := range saved {
		what := "Saved module " + strconv.Quote(m.Id)
		if seen[m.Id] {
			return bad("Saved module id " + strconv.Quote(m.Id) + " is used more than once.")
		}
		seen[m.Id] = true
		if strings.TrimSpace(m.Name) == "" {
			return bad(what + " has a blank name.")
		}
		if m.Module.Type == api.Section {
			return bad(what + " can't be a section.")
		}
		if err := checkModules(what, []api.ReportModule{m.Module}, map[string]bool{}, false); err != nil {
			return err
		}
	}
	return nil
}

// checkReportTemplates checks a preferences patch's report templates
// (#125): template ids are unique, names aren't blank, and module ids are
// unique within a template.
func checkReportTemplates(patch api.Preferences) error {
	templates, err := patch.ReportTemplates.Get()
	if err != nil {
		return nil // Not given, or null.
	}
	bad := func(detail string) error {
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: detail}
	}
	seen := make(map[string]bool, len(templates))
	for _, r := range templates {
		if seen[r.Id] {
			return bad("Report template id " + strconv.Quote(r.Id) + " is used more than once.")
		}
		seen[r.Id] = true
		if strings.TrimSpace(r.Name) == "" {
			return bad("Report template " + strconv.Quote(r.Id) + " has a blank name.")
		}
		if err := checkReportModules("Report template "+strconv.Quote(r.Id), r.Report); err != nil {
			return err
		}
	}
	return nil
}

// checkReportModules checks a report's modules: unique ids, and each with
// the settings of its type and none of the others' (#126). what names the
// report in the error.
func checkReportModules(what string, report api.ReportSettings) error {
	return checkModules(what, report.Modules, map[string]bool{}, false)
}

// checkModules checks modules and, in a section (#194), its modules: ids
// unique across the report, each with its type's settings, and no section
// in a section.
func checkModules(what string, list []api.ReportModule, ids map[string]bool, inSection bool) error {
	for _, m := range list {
		if ids[m.Id] {
			return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: what + " has module id " + strconv.Quote(m.Id) + " more than once."}
		}
		ids[m.Id] = true
		if (m.Graph != nil) != (m.Type == api.Graph) ||
			(m.Transactions != nil) != (m.Type == api.Transactions) ||
			(m.Flows != nil) != (m.Type == api.Flows) ||
			(m.Budget != nil) != (m.Type == api.Budget) ||
			(m.Section != nil) != (m.Type == api.Section) {
			return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: what + " module " + strconv.Quote(m.Id) + " needs the settings of its type, " + string(m.Type) + ", and no others."}
		}
		if m.Section == nil {
			continue
		}
		if inSection {
			return &Error{Status: http.StatusBadRequest, Code: "invalid_request", Detail: what + " module " + strconv.Quote(m.Id) + ": a section can't hold a section."}
		}
		if err := checkModules(what, m.Section.Modules, ids, true); err != nil {
			return err
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
