package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
)

// server implements the operations in api/openapi.yaml.
type server struct {
	db Pinger
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
