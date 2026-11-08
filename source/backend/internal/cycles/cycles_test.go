package cycles_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledgertest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

// Months in Oslo, as the UI would send them.
var (
	oct = [2]time.Time{at("2026-09-30T22:00:00Z"), at("2026-10-31T23:00:00Z")}
	nov = [2]time.Time{at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")}
	dec = [2]time.Time{at("2026-11-30T23:00:00Z"), at("2026-12-31T23:00:00Z")}
)

type env struct {
	pool *pgxpool.Pool
	svc  *cycles.Service
	user string
	now  *time.Time
	log  *[]string // hook calls
}

func setup(t *testing.T, opts ...func(*cycles.Options)) env {
	t.Helper()
	pool := testdb.New(t)
	now := at("2026-09-15T12:00:00Z")
	var log []string
	o := cycles.Options{
		Now: func() time.Time { return now },
		OnEnd: func(_ context.Context, _ pgx.Tx, c sqlc.Cycle) error {
			log = append(log, "end "+c.ID)
			return nil
		},
		OnStart: func(_ context.Context, _ pgx.Tx, c sqlc.Cycle) error {
			log = append(log, "start "+c.ID)
			return nil
		},
	}
	for _, f := range opts {
		f(&o)
	}
	return env{pool: pool, svc: cycles.NewService(pool, o), user: authtest.NewUser(t, pool, "alice").ID, now: &now, log: &log}
}

func (e env) create(t *testing.T, span [2]time.Time) sqlc.Cycle {
	t.Helper()
	c, err := e.svc.Create(t.Context(), e.user, span[0], span[1])
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (e env) get(t *testing.T, id string) sqlc.Cycle {
	t.Helper()
	c, err := e.svc.Get(t.Context(), e.user, id)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func want(t *testing.T, what string, got, wantErr error) {
	t.Helper()
	if !errors.Is(got, wantErr) {
		t.Errorf("%s: got %v, want %v", what, got, wantErr)
	}
}

func TestPlanning(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	o := e.create(t, oct)
	n := e.create(t, nov) // touches October's end: allowed
	if o.State != sqlc.CycleStateFuture || !o.StartAt.Equal(oct[0]) || !o.EndAt.Equal(oct[1]) {
		t.Errorf("created %+v", o)
	}

	_, err := e.svc.Create(ctx, e.user, at("2026-10-15T00:00:00Z"), at("2026-11-15T00:00:00Z"))
	want(t, "overlap", err, cycles.ErrOverlap)
	_, err = e.svc.Create(ctx, e.user, dec[1], dec[0])
	want(t, "end before start", err, cycles.ErrInvalid)
	_, err = e.svc.Create(ctx, e.user, at("2026-08-01T00:00:00Z"), at("2026-09-01T00:00:00Z"))
	want(t, "in the past", err, cycles.ErrInvalid)

	// Another user's cycles may overlap and can't be seen.
	bob := authtest.NewUser(t, e.pool, "bob").ID
	if _, err := e.svc.Create(ctx, bob, oct[0], oct[1]); err != nil {
		t.Errorf("bob's October: %v", err)
	}
	_, err = e.svc.Get(ctx, bob, o.ID)
	want(t, "bob gets alice's cycle", err, cycles.ErrNotFound)
	want(t, "bob deletes alice's cycle", e.svc.Delete(ctx, bob, o.ID), cycles.ErrNotFound)

	// Edit and delete a planned cycle.
	end := at("2026-11-25T23:00:00Z")
	if c, err := e.svc.Update(ctx, e.user, n.ID, cycles.Changes{EndAt: &end}); err != nil || !c.EndAt.Equal(end) {
		t.Errorf("update: %+v, %v", c, err)
	}
	early := at("2026-10-20T00:00:00Z")
	_, err = e.svc.Update(ctx, e.user, n.ID, cycles.Changes{StartAt: &early})
	want(t, "update into overlap", err, cycles.ErrOverlap)
	if err := e.svc.Delete(ctx, e.user, n.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := e.svc.List(ctx, e.user); len(list) != 1 {
		t.Errorf("%d cycles after delete, want 1", len(list))
	}
}

func TestStart(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	o := e.create(t, oct)
	n := e.create(t, nov)

	_, err := e.svc.Start(ctx, e.user, n.ID)
	want(t, "start the later cycle", err, cycles.ErrNotNext)

	// Started before its planned start: it starts now.
	c, err := e.svc.Start(ctx, e.user, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if c.State != sqlc.CycleStateActive || !c.StartAt.Equal(*e.now) || !c.EndAt.Equal(oct[1]) {
		t.Errorf("started %+v", c)
	}
	if !slices.Equal(*e.log, []string{"start " + o.ID}) {
		t.Errorf("hooks %v", *e.log)
	}
	_, err = e.svc.Start(ctx, e.user, n.ID)
	want(t, "start a second cycle", err, cycles.ErrActiveExists)
	_, err = e.svc.Start(ctx, e.user, o.ID)
	want(t, "start the active cycle", err, cycles.ErrNotFuture)
	want(t, "delete the active cycle", e.svc.Delete(ctx, e.user, o.ID), cycles.ErrNotFuture)

	cur, err := e.svc.Current(ctx, e.user)
	if err != nil || cur.Active == nil || cur.Active.ID != o.ID || cur.Next == nil || cur.Next.ID != n.ID {
		t.Errorf("current %+v, %v", cur, err)
	}

	// Started after its planned start: it keeps it.
	e2 := setup(t)
	*e2.now = at("2026-10-03T08:00:00Z")
	c2 := e2.create(t, oct)
	if c2, err = e2.svc.Start(ctx, e2.user, c2.ID); err != nil || !c2.StartAt.Equal(oct[0]) {
		t.Errorf("late start %+v, %v", c2, err)
	}
}

func TestEnd(t *testing.T) {
	ctx := context.Background()

	// running sets up October (active) and November (planned), with now on
	// the given day.
	running := func(t *testing.T, now string) (env, sqlc.Cycle, sqlc.Cycle) {
		e := setup(t)
		*e.now = at("2026-09-30T22:00:00Z")
		o := e.create(t, oct)
		n := e.create(t, nov)
		if _, err := e.svc.Start(ctx, e.user, o.ID); err != nil {
			t.Fatal(err)
		}
		*e.now = at(now)
		*e.log = nil
		return e, o, n
	}

	t.Run("on time", func(t *testing.T) {
		e, o, n := running(t, "2026-10-31T23:00:00Z")
		res, err := e.svc.End(ctx, e.user, o.ID, false)
		if err != nil {
			t.Fatal(err)
		}
		if res.Ended.State != sqlc.CycleStateFinished || !res.Ended.EndAt.Equal(oct[1]) {
			t.Errorf("ended %+v", res.Ended)
		}
		if res.Started == nil || res.Started.ID != n.ID || !res.Started.StartAt.Equal(nov[0]) {
			t.Errorf("started %+v", res.Started)
		}
		if !slices.Equal(*e.log, []string{"end " + o.ID, "start " + n.ID}) {
			t.Errorf("hooks %v", *e.log)
		}
	})

	t.Run("overdue keeps the planned end", func(t *testing.T) {
		e, o, n := running(t, "2026-11-02T10:00:00Z")
		res, err := e.svc.End(ctx, e.user, o.ID, false)
		if err != nil {
			t.Fatal(err)
		}
		if !res.Ended.EndAt.Equal(oct[1]) || res.Started == nil || res.Started.ID != n.ID || !res.Started.StartAt.Equal(nov[0]) {
			t.Errorf("ended %+v, started %+v", res.Ended, res.Started)
		}
	})

	t.Run("early, start next now", func(t *testing.T) {
		e, o, n := running(t, "2026-10-20T10:00:00Z")
		res, err := e.svc.End(ctx, e.user, o.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		if !res.Ended.EndAt.Equal(*e.now) {
			t.Errorf("ended at %s, want now", res.Ended.EndAt)
		}
		if res.Started == nil || res.Started.ID != n.ID || !res.Started.StartAt.Equal(*e.now) || !res.Started.EndAt.Equal(nov[1]) {
			t.Errorf("started %+v", res.Started)
		}
	})

	t.Run("early, leave a gap", func(t *testing.T) {
		e, o, n := running(t, "2026-10-20T10:00:00Z")
		res, err := e.svc.End(ctx, e.user, o.ID, false)
		if err != nil {
			t.Fatal(err)
		}
		if res.Started != nil {
			t.Errorf("started %+v, want a gap", res.Started)
		}
		if c := e.get(t, n.ID); c.State != sqlc.CycleStateFuture || !c.StartAt.Equal(nov[0]) {
			t.Errorf("next cycle %+v", c)
		}
		// No active cycle: bucket lines are refused.
		acc := ledgertest.Account(t, e.pool, e.user, "")
		b := ledgertest.Bucket(t, e.pool, e.user, acc)
		_, err = ledger.New(ledger.Options{}).Create(ctx, e.pool, ledger.Entry{
			UserID: e.user, Type: sqlc.TransactionTypeREF, At: *e.now,
			BucketLines: []ledger.BucketLine{{BucketID: b, Amount: decimal.NewFromInt(1)}},
		})
		want(t, "bucket line in a gap", err, ledger.ErrNoActiveCycle)
	})

	t.Run("early, keeps later bucket lines inside", func(t *testing.T) {
		e, o, _ := running(t, "2026-10-20T10:00:00Z")
		acc := ledgertest.Account(t, e.pool, e.user, "")
		b := ledgertest.Bucket(t, e.pool, e.user, acc)
		later := at("2026-10-25T09:00:00Z")
		if _, err := ledger.New(ledger.Options{}).Create(ctx, e.pool, ledger.Entry{
			UserID: e.user, Type: sqlc.TransactionTypeREF, At: later,
			BucketLines: []ledger.BucketLine{{BucketID: b, Amount: decimal.NewFromInt(1)}},
		}); err != nil {
			t.Fatal(err)
		}
		res, err := e.svc.End(ctx, e.user, o.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		if !res.Ended.EndAt.Equal(later.Add(time.Microsecond)) || !res.Started.StartAt.Equal(res.Ended.EndAt) {
			t.Errorf("ended at %s, next starts %s", res.Ended.EndAt, res.Started.StartAt)
		}
	})

	t.Run("no next cycle", func(t *testing.T) {
		e, o, n := running(t, "2026-10-31T23:00:00Z")
		if err := e.svc.Delete(ctx, e.user, n.ID); err != nil {
			t.Fatal(err)
		}
		res, err := e.svc.End(ctx, e.user, o.ID, true)
		if err != nil || res.Started != nil {
			t.Errorf("got %+v, %v", res, err)
		}
		cur, _ := e.svc.Current(ctx, e.user)
		if cur.Active != nil || cur.Next != nil {
			t.Errorf("current %+v", cur)
		}
		_, err = e.svc.End(ctx, e.user, o.ID, false)
		want(t, "end a finished cycle", err, cycles.ErrNotActive)
		end := at("2026-12-01T00:00:00Z")
		_, err = e.svc.Update(ctx, e.user, o.ID, cycles.Changes{EndAt: &end})
		want(t, "edit a finished cycle", err, cycles.ErrFinished)
	})
}

func TestExtend(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	*e.now = at("2026-09-30T22:00:00Z")
	o := e.create(t, oct)
	n := e.create(t, nov)
	if _, err := e.svc.Start(ctx, e.user, o.ID); err != nil {
		t.Fatal(err)
	}
	*e.now = at("2026-11-01T08:00:00Z") // overdue

	// Extending pushes November's start along.
	end := at("2026-11-02T23:00:00Z")
	c, err := e.svc.Update(ctx, e.user, o.ID, cycles.Changes{EndAt: &end})
	if err != nil {
		t.Fatal(err)
	}
	if !c.EndAt.Equal(end) || c.State != sqlc.CycleStateActive {
		t.Errorf("extended %+v", c)
	}
	if next := e.get(t, n.ID); !next.StartAt.Equal(end) || !next.EndAt.Equal(nov[1]) {
		t.Errorf("next cycle %+v", next)
	}

	start := at("2026-10-02T00:00:00Z")
	_, err = e.svc.Update(ctx, e.user, o.ID, cycles.Changes{StartAt: &start})
	want(t, "move the active cycle's start", err, cycles.ErrInvalid)
	past := at("2026-11-01T00:00:00Z")
	_, err = e.svc.Update(ctx, e.user, o.ID, cycles.Changes{EndAt: &past})
	want(t, "end in the past", err, cycles.ErrInvalid)

	// Past the end of November's (#158): it's removed, and the next one is
	// pushed along.
	d := e.create(t, [2]time.Time{nov[1], at("2027-01-01T00:00:00Z")})
	beyond := at("2026-12-05T00:00:00Z")
	if _, err := e.svc.Update(ctx, e.user, o.ID, cycles.Changes{EndAt: &beyond}); err != nil {
		t.Fatalf("over the next cycle: %v", err)
	}
	if _, err := sqlc.New(e.pool).GetCycle(ctx, sqlc.GetCycleParams{ID: n.ID, UserID: e.user}); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("November's is still there: %v", err)
	}
	if next := e.get(t, d.ID); !next.StartAt.Equal(beyond) || !next.EndAt.Equal(at("2027-01-01T00:00:00Z")) {
		t.Errorf("December's %+v", next)
	}
	// Past every planned cycle: they all go.
	far := at("2027-02-01T00:00:00Z")
	if _, err := e.svc.Update(ctx, e.user, o.ID, cycles.Changes{EndAt: &far}); err != nil {
		t.Fatalf("over every cycle: %v", err)
	}
	if _, err := sqlc.New(e.pool).GetCycle(ctx, sqlc.GetCycleParams{ID: d.ID, UserID: e.user}); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("December's is still there: %v", err)
	}
}

func TestHookErrorRollsBack(t *testing.T) {
	boom := errors.New("boom")
	e := setup(t, func(o *cycles.Options) {
		o.OnStart = func(context.Context, pgx.Tx, sqlc.Cycle) error { return boom }
	})
	*e.now = at("2026-09-30T22:00:00Z")
	o := e.create(t, oct)
	e.create(t, nov)
	_, err := e.svc.Start(t.Context(), e.user, o.ID)
	want(t, "start", err, boom)
	if c := e.get(t, o.ID); c.State != sqlc.CycleStateFuture {
		t.Errorf("state %s after a failed start", c.State)
	}
}
