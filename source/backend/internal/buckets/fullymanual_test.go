package buckets_test

import (
	"errors"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
)

// TestFullyManual: a Fully manual bucket (#76) has no RA, always keeps its
// funds, and has a fixed capacity or none.
func TestFullyManual(t *testing.T) {
	e := setup(t)
	e.startCycle(t)
	free := e.create(t, buckets.New{Name: "Gifts", RefillMode: sqlc.RefillModeFullyManual})
	if free.CapMode != sqlc.BucketCapModeNone || free.Capacity.Valid || free.CapMultiplier.Valid || free.CapAmount.Valid {
		t.Errorf("no cap: %s %v %v BC %v", free.CapMode, free.CapMultiplier, free.CapAmount, free.Capacity)
	}
	if !free.KeepFunds || !free.RefillAmount.IsZero() {
		t.Errorf("keep funds %t RA %s, want on and 0", free.KeepFunds, free.RefillAmount)
	}
	capped := e.create(t, buckets.New{
		Name: "Holiday", RefillMode: sqlc.RefillModeFullyManual, CapMode: sqlc.BucketCapModeFixed,
		CapAmount: dec("1000"), OpeningFunds: dec("200"),
	})
	if !capped.Capacity.Decimal.Equal(dec("1000")) || e.tf(t, capped.ID) != "200.00" || capped.Refilled {
		t.Errorf("capped: BC %v TF %s refilled %t, want 1000, 200, not refilled", capped.Capacity, e.tf(t, capped.ID), capped.Refilled)
	}

	for _, tc := range []struct {
		name string
		n    buckets.New
	}{
		{"a refill amount", buckets.New{RefillMode: sqlc.RefillModeFullyManual, RefillAmount: dec("100")}},
		{"a multiplier", buckets.New{RefillMode: sqlc.RefillModeFullyManual, CapMode: sqlc.BucketCapModeMultiplier}},
		{"no cap with auto", buckets.New{RefillMode: sqlc.RefillModeAuto, CapMode: sqlc.BucketCapModeNone}},
		{"opening funds above BC", buckets.New{
			RefillMode: sqlc.RefillModeFullyManual, CapMode: sqlc.BucketCapModeFixed, CapAmount: dec("100"), OpeningFunds: dec("150"),
		}},
	} {
		tc.n.Name, tc.n.SourceAccountID = "Refused", e.account
		if _, err := e.svc.Create(t.Context(), e.user, tc.n); !errors.Is(err, buckets.ErrInvalid) {
			t.Errorf("create with %s: %v", tc.name, err)
		}
	}

	// Add and Remove funds are temporary adjustments, up to the capacity and
	// down to 0.
	adjust := func(id, mode, value string) error {
		a := buckets.Adjustment{Mode: buckets.Mode(mode)}
		if mode == string(buckets.ModeTemporary) {
			a.TargetFunds = ptr(dec(value))
		} else {
			a.RefillAmount = ptr(dec(value))
		}
		_, err := e.svc.Adjust(t.Context(), e.user, id, a)
		return err
	}
	if err := adjust(capped.ID, "temporary", "700"); err != nil || e.tf(t, capped.ID) != "700.00" {
		t.Errorf("add 500: %v, TF %s", err, e.tf(t, capped.ID))
	}
	if err := adjust(capped.ID, "temporary", "1100"); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("above the capacity: %v", err)
	}
	if err := adjust(free.ID, "temporary", "50000"); err != nil {
		t.Errorf("no cap: %v", err)
	}
	if err := adjust(capped.ID, "temporary", "0"); err != nil || e.tf(t, capped.ID) != "0.00" {
		t.Errorf("remove all: %v, TF %s", err, e.tf(t, capped.ID))
	}
	for _, mode := range []string{"future", "both"} {
		if err := adjust(capped.ID, mode, "100"); !errors.Is(err, buckets.ErrInvalid) {
			t.Errorf("%s adjustment: %v", mode, err)
		}
	}
	if n := e.count(t, sqlc.TransactionTypeBUA); n != 3 {
		t.Errorf("%d BUAs, want 3", n)
	}

	// Moves into it stay under the capacity; RA moves aren't possible.
	food := e.create(t, buckets.New{Name: "Food", RefillAmount: dec("500"), OpeningFunds: dec("1500")})
	if _, _, err := e.svc.Transfer(t.Context(), e.user, food.ID, buckets.Transfer{To: capped.ID, Mode: buckets.ModeTemporary, Amount: dec("1000")}); err != nil {
		t.Errorf("move to the capacity: %v", err)
	}
	if _, _, err := e.svc.Transfer(t.Context(), e.user, food.ID, buckets.Transfer{To: capped.ID, Mode: buckets.ModeTemporary, Amount: dec("0.01")}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("move above the capacity: %v", err)
	}
	if _, _, err := e.svc.Transfer(t.Context(), e.user, capped.ID, buckets.Transfer{To: food.ID, Mode: buckets.ModeTemporary, Amount: dec("300")}); err != nil {
		t.Errorf("move out: %v", err)
	}
	for _, mode := range []buckets.Mode{buckets.ModeFuture, buckets.ModeBoth} {
		if _, _, err := e.svc.Transfer(t.Context(), e.user, food.ID, buckets.Transfer{To: free.ID, Mode: mode, Amount: dec("100")}); !errors.Is(err, buckets.ErrInvalid) {
			t.Errorf("%s move: %v", mode, err)
		}
	}

	// Budget setup can't give it a refill amount.
	if _, err := e.svc.SetRefillAmounts(t.Context(), e.user, []buckets.RefillAmount{{BucketID: food.ID, Amount: dec("600")}, {BucketID: free.ID, Amount: dec("100")}}, false); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("refill amounts: %v", err)
	}
	if got := e.get(t, food.ID); !got.RefillAmount.Equal(dec("500")) {
		t.Errorf("food RA %s, want 500 (all or nothing)", got.RefillAmount)
	}
}

// TestSwitchFullyManual: switching to Fully manual clears RA and turns Keep
// funds on, but TF stays; switching back gives a ×1 capacity.
func TestSwitchFullyManual(t *testing.T) {
	e := setup(t)
	e.startCycle(t)
	b := e.create(t, buckets.New{Name: "Car", RefillAmount: dec("800"), CapMultiplier: dec("2"), OpeningFunds: dec("300")})

	for _, tc := range []struct {
		name string
		c    buckets.Changes
	}{
		{"a refill amount", buckets.Changes{RefillAmount: ptr(dec("100"))}},
		{"keep funds off", buckets.Changes{KeepFunds: ptr(false)}},
		{"a multiplier", buckets.Changes{CapMode: ptr(sqlc.BucketCapModeMultiplier)}},
	} {
		tc.c.RefillMode = ptr(sqlc.RefillModeFullyManual)
		if _, err := e.svc.Update(t.Context(), e.user, b.ID, tc.c); !errors.Is(err, buckets.ErrInvalid) {
			t.Errorf("switch with %s: %v", tc.name, err)
		}
	}
	if _, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapMode: ptr(sqlc.BucketCapModeNone)}); !errors.Is(err, buckets.ErrInvalid) {
		t.Errorf("no cap on an auto bucket: %v", err)
	}

	got, err := e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{RefillMode: ptr(sqlc.RefillModeFullyManual)})
	if err != nil {
		t.Fatal(err)
	}
	if !got.RefillAmount.IsZero() || !got.KeepFunds || got.CapMode != sqlc.BucketCapModeNone || got.Capacity.Valid || e.tf(t, b.ID) != "300.00" {
		t.Errorf("switched: RA %s keep %t cap %s BC %v TF %s, want 0, on, none, unset, 300",
			got.RefillAmount, got.KeepFunds, got.CapMode, got.Capacity, e.tf(t, b.ID))
	}
	// Its other settings can still change.
	if got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapMode: ptr(sqlc.BucketCapModeFixed), CapAmount: ptr(dec("500"))}); err != nil || !got.Capacity.Decimal.Equal(dec("500")) {
		t.Errorf("fixed cap: %v, BC %v", err, got.Capacity)
	}
	if got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{CapMode: ptr(sqlc.BucketCapModeNone)}); err != nil || got.CapAmount.Valid || got.Capacity.Valid {
		t.Errorf("back to no cap: %v, %v", err, got.CapAmount)
	}

	got, err = e.svc.Update(t.Context(), e.user, b.ID, buckets.Changes{RefillMode: ptr(sqlc.RefillModeManual), RefillAmount: ptr(dec("400"))})
	if err != nil {
		t.Fatal(err)
	}
	if got.CapMode != sqlc.BucketCapModeMultiplier || !got.CapMultiplier.Decimal.Equal(dec("1")) || !got.Capacity.Decimal.Equal(dec("400")) || !got.KeepFunds {
		t.Errorf("switched back: cap %s × %v BC %v keep %t, want ×1 = 400, keep funds as it was", got.CapMode, got.CapMultiplier, got.Capacity, got.KeepFunds)
	}
}
