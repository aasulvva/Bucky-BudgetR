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

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// server implements the operations in api/openapi.yaml. Gate has already
// checked sessions and validated requests against the spec.
type server struct {
	db   Pinger
	auth *auth.Service
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
	patch, err := json.Marshal(req.Body)
	if err != nil {
		return nil, err
	}
	stored, err := s.auth.UpdatePreferences(ctx, sessionFrom(ctx).User.ID, patch)
	if err != nil {
		return nil, err
	}
	prefs, err := toAPIPreferences(stored)
	if err != nil {
		return nil, err
	}
	return api.UpdatePreferences200JSONResponse(prefs), nil
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
