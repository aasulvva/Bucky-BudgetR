package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/legacy"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
)

// maxBodyBytes limits API request bodies.
const maxBodyBytes = 1 << 20

// allowedBeforePasswordChange marks operations in the spec that a user who
// must change their password may still call.
const allowedBeforePasswordChange = "x-allowed-before-password-change"

// adminOnly marks operations in the spec that only admins may call.
const adminOnly = "x-admin-only"

// Gate enforces what api/openapi.yaml says about each operation, before the
// handler runs:
//   - operations with security require a session (401 otherwise);
//   - a user who must change their password may only call operations marked
//     x-allowed-before-password-change (403 otherwise);
//   - operations marked x-admin-only need an admin (403 otherwise);
//   - the request must match the spec: parameters, body schema, lengths,
//     patterns, no unknown fields (400 otherwise).
//
// Requests for paths not in the spec pass through untouched.
func Gate() (func(http.Handler) http.Handler, error) {
	spec, err := api.GetSpec()
	if err != nil {
		return nil, fmt.Errorf("load API spec: %w", err)
	}
	router, err := legacy.NewRouter(spec)
	if err != nil {
		return nil, fmt.Errorf("route API spec: %w", err)
	}
	opts := &openapi3filter.Options{
		// Sessions are checked below, not by the validator.
		AuthenticationFunc: openapi3filter.NoopAuthenticationFunc,
		// Keep error messages short: no schema or value dumps.
		SchemaValidationOptions: []openapi3.SchemaValidationOption{openapi3.DisableSchemaErrorDetails()},
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			route, params, err := router.FindRoute(r)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			op := route.Operation

			sess := sessionFrom(r.Context())
			if requiresSession(spec, op) && sess == nil {
				WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Log in first.")
				return
			}
			if sess != nil && sess.User.MustChangePassword && op.Extensions[allowedBeforePasswordChange] != true {
				WriteProblem(w, r, http.StatusForbidden, "password_change_required", "Change your password first.")
				return
			}
			if op.Extensions[adminOnly] == true && (sess == nil || !sess.User.Admin) {
				WriteProblem(w, r, http.StatusForbidden, "admin_only", "Only admins can do this.")
				return
			}

			r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
			err = openapi3filter.ValidateRequest(r.Context(), &openapi3filter.RequestValidationInput{
				Request:    r,
				PathParams: params,
				Route:      route,
				Options:    opts,
			})
			var tooLarge *http.MaxBytesError
			switch {
			case errors.As(err, &tooLarge):
				WriteProblem(w, r, http.StatusRequestEntityTooLarge, "body_too_large", "")
				return
			case err != nil:
				WriteProblem(w, r, http.StatusBadRequest, "invalid_request", validationDetail(err))
				return
			}
			next.ServeHTTP(w, r)
		})
	}, nil
}

func requiresSession(spec *openapi3.T, op *openapi3.Operation) bool {
	if op.Security != nil {
		return len(*op.Security) > 0
	}
	return len(spec.Security) > 0
}

// validationDetail turns a validation error into a short message for the
// client, e.g. `request body: property "foo" is unsupported`.
func validationDetail(err error) string {
	var reqErr *openapi3filter.RequestError
	if !errors.As(err, &reqErr) {
		return err.Error()
	}
	where := "request"
	switch {
	case reqErr.Parameter != nil:
		where = fmt.Sprintf("parameter %q", reqErr.Parameter.Name)
	case reqErr.RequestBody != nil:
		where = "request body"
	}
	var schemaErr *openapi3.SchemaError
	if errors.As(reqErr.Err, &schemaErr) {
		if path := schemaErr.JSONPointer(); len(path) > 0 {
			return fmt.Sprintf("%s: %s: %s", where, strings.Join(path, "."), schemaErr.Reason)
		}
		return fmt.Sprintf("%s: %s", where, schemaErr.Reason)
	}
	if reqErr.Err != nil {
		return fmt.Sprintf("%s: %v", where, reqErr.Err)
	}
	return fmt.Sprintf("%s: %s", where, reqErr.Reason)
}
