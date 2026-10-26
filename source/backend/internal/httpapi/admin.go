package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/auth"
)

// User management (spec §1). The gate lets only admins through
// (x-admin-only).

func (s *server) ListUsers(ctx context.Context, _ api.ListUsersRequestObject) (api.ListUsersResponseObject, error) {
	users, err := s.auth.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	out := make(api.ListUsers200JSONResponse, len(users))
	for i, u := range users {
		out[i] = toAPIAdminUser(u)
	}
	return out, nil
}

func (s *server) CreateUser(ctx context.Context, req api.CreateUserRequestObject) (api.CreateUserResponseObject, error) {
	admin := req.Body.Admin != nil && *req.Body.Admin
	u, password, err := s.auth.CreateUser(ctx, sessionFrom(ctx).User.ID, req.Body.Username, admin)
	if err != nil {
		return nil, adminError(err)
	}
	return api.CreateUser201JSONResponse{User: toAPIAdminUser(u), TemporaryPassword: password}, nil
}

func (s *server) UpdateUser(ctx context.Context, req api.UpdateUserRequestObject) (api.UpdateUserResponseObject, error) {
	c := auth.UserChanges{Active: req.Body.Active, Admin: req.Body.Admin}
	u, err := s.auth.UpdateUser(ctx, sessionFrom(ctx).User.ID, req.UserId, c)
	if err != nil {
		return nil, adminError(err)
	}
	return api.UpdateUser200JSONResponse(toAPIAdminUser(u)), nil
}

func (s *server) ResetUserPassword(ctx context.Context, req api.ResetUserPasswordRequestObject) (api.ResetUserPasswordResponseObject, error) {
	password, err := s.auth.ResetPassword(ctx, sessionFrom(ctx).User.ID, req.UserId)
	if err != nil {
		return nil, adminError(err)
	}
	return api.ResetUserPassword200JSONResponse{TemporaryPassword: password}, nil
}

func adminError(err error) error {
	switch {
	case errors.Is(err, auth.ErrUserNotFound):
		return &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "User not found.", Err: err}
	case errors.Is(err, auth.ErrUsernameTaken):
		return &Error{Status: http.StatusConflict, Code: "username_taken", Detail: "This username is taken."}
	case errors.Is(err, auth.ErrInvalidUsername):
		return &Error{Status: http.StatusBadRequest, Code: "invalid_request",
			Detail: "Use 3–32 letters, digits, dots, underscores or hyphens."}
	case errors.Is(err, auth.ErrLastAdmin):
		return &Error{Status: http.StatusConflict, Code: "last_admin",
			Detail: "This is the last active admin. Make another user an admin first."}
	case errors.Is(err, auth.ErrOwnAccount):
		return &Error{Status: http.StatusConflict, Code: "own_account",
			Detail: "You can't change your own account here. Use Settings to change your password."}
	}
	return err
}

func toAPIAdminUser(u auth.ManagedUser) api.AdminUser {
	out := api.AdminUser{
		Id:                 u.ID,
		Username:           u.Username,
		Active:             u.Active,
		Admin:              u.Admin,
		MustChangePassword: u.MustChangePassword,
		CreatedAt:          u.CreatedAt,
		CreatedBy:          nullable.NewNullNullable[api.UserId](),
		LastSeenAt:         nullable.NewNullNullable[time.Time](),
	}
	if u.CreatedBy != "" {
		out.CreatedBy = nullable.NewNullableWithValue(u.CreatedBy)
	}
	if u.LastSeenAt != nil {
		out.LastSeenAt = nullable.NewNullableWithValue(*u.LastSeenAt)
	}
	return out
}
