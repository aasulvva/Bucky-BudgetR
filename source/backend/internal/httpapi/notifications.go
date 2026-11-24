package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oapi-codegen/nullable"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/api"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/notifications"
)

func (s *server) ListNotifications(ctx context.Context, _ api.ListNotificationsRequestObject) (api.ListNotificationsResponseObject, error) {
	svc, err := s.notificationService()
	if err != nil {
		return nil, err
	}
	list, err := svc.List(ctx, sessionFrom(ctx).User.ID)
	if err != nil {
		return nil, err
	}
	out := api.ListNotifications200JSONResponse{Items: make([]api.Notification, len(list))}
	for i, n := range list {
		out.Items[i] = toAPINotification(n)
	}
	return out, nil
}

func (s *server) DismissNotification(ctx context.Context, req api.DismissNotificationRequestObject) (api.DismissNotificationResponseObject, error) {
	svc, err := s.notificationService()
	if err != nil {
		return nil, err
	}
	if err := svc.Dismiss(ctx, sessionFrom(ctx).User.ID, req.Body.Key); err != nil {
		if errors.Is(err, notifications.ErrNotFound) {
			return nil, &Error{Status: http.StatusNotFound, Code: "not_found", Detail: "Notification not found.", Err: err}
		}
		return nil, err
	}
	return api.DismissNotification204Response{}, nil
}

func (s *server) notificationService() (*notifications.Service, error) {
	if s.notifications == nil {
		return nil, NewError(http.StatusServiceUnavailable, "notifications_unavailable", "")
	}
	return s.notifications, nil
}

func toAPINotification(n notifications.Notification) api.Notification {
	text := func(v string) nullable.Nullable[string] {
		if v == "" {
			return nullable.NewNullNullable[string]()
		}
		return nullable.NewNullableWithValue(v)
	}
	out := api.Notification{
		Key: n.Key, Kind: api.NotificationKind(n.Kind), Severity: api.NotificationSeverity(n.Severity),
		At: nullable.NewNullNullable[time.Time](), Count: nullable.NewNullNullable[int](),
		Overdue:    nullable.NewNullNullable[int](),
		ScheduleId: text(n.ScheduleID), AccountId: text(n.AccountID), BucketId: text(n.BucketID),
		CycleId: text(n.CycleID), TargetId: text(n.TargetID), Amount: nullable.NewNullNullable[string](), Currency: text(n.Currency),
		Minimum:       nullable.NewNullNullable[string](),
		TransactionId: text(n.TransactionID), Counterparty: text(n.Counterparty),
	}
	if !n.At.IsZero() {
		out.At = nullable.NewNullableWithValue(n.At.UTC())
	}
	if n.Kind == notifications.KindQueue {
		out.Count = nullable.NewNullableWithValue(n.Count)
		out.Overdue = nullable.NewNullableWithValue(n.Overdue)
	}
	if n.Amount.Valid {
		out.Amount = nullable.NewNullableWithValue(n.Amount.Decimal.StringFixed(money.Places))
	}
	if n.Minimum.Valid {
		out.Minimum = nullable.NewNullableWithValue(n.Minimum.Decimal.StringFixed(money.Places))
	}
	return out
}
