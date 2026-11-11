package debug

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/accounts"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/allocation"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/authtest"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/buckets"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cycles"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/refill"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/schedules"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func TestClock(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	real := at("2026-10-27T12:00:00Z")
	d, err := initWith(ctx, pool, func() time.Time { return real })
	if err != nil {
		t.Fatal(err)
	}
	c := d.Clock
	if !c.Now().Equal(real) || c.State().Mode != Real {
		t.Fatalf("starts on real time: %v %v", c.Now(), c.State())
	}

	target := at("2026-11-30T23:00:00Z")
	if err := c.Set(ctx, &target, false); err != nil {
		t.Fatal(err)
	}
	real = real.Add(time.Hour)
	if want := target.Add(time.Hour); !c.Now().Equal(want) {
		t.Errorf("running: %v, want %v", c.Now(), want)
	}

	if err := c.Set(ctx, &target, true); err != nil {
		t.Fatal(err)
	}
	real = real.Add(time.Hour)
	if !c.Now().Equal(target) {
		t.Errorf("frozen: %v, want %v", c.Now(), target)
	}

	// The setting survives a restart.
	again, err := initWith(ctx, pool, func() time.Time { return real })
	if err != nil {
		t.Fatal(err)
	}
	if s := again.Clock.State(); s.Mode != Frozen || !again.Clock.Now().Equal(target) {
		t.Errorf("after a restart: %+v", s)
	}

	if err := c.Set(ctx, nil, false); err != nil {
		t.Fatal(err)
	}
	if !c.Now().Equal(real) || c.State().Mode != Real {
		t.Errorf("reset: %v", c.Now())
	}
}

// env is a user with the services on the debug clock.
type env struct {
	pool     *pgxpool.Pool
	d        *Debug
	accounts *accounts.Service
	buckets  *buckets.Service
	cycles   *cycles.Service
	tx       *transactions.Service
	sched    *schedules.Service
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	d, err := Init(t.Context(), pool)
	if err != nil {
		t.Fatal(err)
	}
	now := at("2026-10-10T12:00:00Z")
	if err := d.Clock.Set(t.Context(), &now, true); err != nil {
		t.Fatal(err)
	}
	clock := d.Clock.Now
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	r := refill.NewService(pool, l, refill.Options{Now: clock})
	tx := transactions.NewService(pool, l, transactions.Options{Now: clock, Refills: r})
	return env{
		pool: pool, d: d,
		accounts: accounts.NewService(pool, l, accounts.Options{Now: clock}),
		buckets:  buckets.NewService(pool, l, buckets.Options{Now: clock, OnCreate: r.OnCreate}),
		cycles:   cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart}),
		tx:       tx,
		sched:    schedules.NewService(pool, schedules.Options{Now: clock, Transactions: tx}),
	}
}

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

// scenario gives the user one of everything: accounts, an active and a
// planned cycle, a refilled bucket, tagged transactions, a correction, a
// reversal, a move, schedules with an applied and a queued occurrence, and
// preferences with IDs.
func (e env) scenario(t *testing.T, userID string) {
	t.Helper()
	ctx := t.Context()
	oct := must[sqlc.Cycle](t)(e.cycles.Create(ctx, userID, at("2026-09-30T22:00:00Z"), at("2026-10-31T23:00:00Z")))
	must[sqlc.Cycle](t)(e.cycles.Create(ctx, userID, at("2026-10-31T23:00:00Z"), at("2026-11-30T23:00:00Z")))
	must[sqlc.Cycle](t)(e.cycles.Start(ctx, userID, oct.ID))
	a := must[accounts.Account](t)(e.accounts.Create(ctx, userID, accounts.New{Name: "Main", OpeningBalance: dec("1000")}))
	b := must[accounts.Account](t)(e.accounts.Create(ctx, userID, accounts.New{Name: "Savings", OpeningBalance: dec("500")}))
	food := must[buckets.Bucket](t)(e.buckets.Create(ctx, userID, buckets.New{
		Name: "Food", SourceAccountID: a.ID, RefillAmount: dec("300"), CapMultiplier: dec("1"), Refill: true,
	}))
	exp := must[transactions.Transaction](t)(e.tx.Create(ctx, userID, transactions.New{
		Type: sqlc.TransactionTypeEXP, Counterparty: "Rema", Tags: []string{"food", "weekly"}, AccountID: a.ID,
		Amount: dec("150"), Buckets: []transactions.BucketAmount{{BucketID: food.ID, Amount: dec("150")}},
	}))
	amount := dec("120.50")
	must[transactions.Transaction](t)(e.tx.Correct(ctx, userID, exp.ID, transactions.Changes{
		Amount: &amount, SetBuckets: true, Buckets: []transactions.BucketAmount{{BucketID: food.ID, Amount: amount}},
	}))
	oops := must[transactions.Transaction](t)(e.tx.Create(ctx, userID, transactions.New{
		Type: sqlc.TransactionTypeEXP, Counterparty: "Oops", AccountID: a.ID, Amount: dec("10"),
	}))
	must[transactions.Transaction](t)(e.tx.Reverse(ctx, userID, oops.ID))
	moved := must[transactions.Transaction](t)(e.tx.Create(ctx, userID, transactions.New{
		Type: sqlc.TransactionTypeINC, Counterparty: "Gift", Tags: []string{"gift"}, AccountID: a.ID, Amount: dec("75"),
	}))
	must[transactions.Transaction](t)(e.tx.Correct(ctx, userID, moved.ID, transactions.Changes{AccountID: &b.ID}))
	must[transactions.Transaction](t)(e.tx.Create(ctx, userID, transactions.New{
		Type: sqlc.TransactionTypeTRF, AccountID: a.ID, ToAccountID: b.ID, Amount: dec("100"),
	}))
	// Due now: the scheduler applies the first and queues the second.
	daily := schedules.Settings{
		Transaction: transactions.New{Type: sqlc.TransactionTypeEXP, Counterparty: "Lunch", Tags: []string{"food"}, AccountID: a.ID,
			Amount: dec("20"), Buckets: []transactions.BucketAmount{{BucketID: food.ID, Amount: dec("20")}}},
		Mode: sqlc.ScheduleModeAuto, DueDays: 3, Start: at("2026-10-10T00:00:00Z"), Minute: 12 * 60, TimeZone: "UTC",
		Frequency: sqlc.ScheduleFrequencyDay, Every: 1,
	}
	must[schedules.Schedule](t)(e.sched.Create(ctx, userID, daily))
	monthly := daily
	monthly.Transaction = transactions.New{Type: sqlc.TransactionTypeTRF, AccountID: a.ID, ToAccountID: b.ID, Amount: dec("50")}
	monthly.Mode, monthly.Frequency = sqlc.ScheduleModeApprove, sqlc.ScheduleFrequencyMonth
	must[schedules.Schedule](t)(e.sched.Create(ctx, userID, monthly))
	if err := e.sched.RunDue(ctx, slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	prefs := fmt.Sprintf(`{"locale":"nb-NO","dashboard":{"accounts":{"mode":"account","account_id":%q},"bucket_status":{"mode":"bucket","bucket_id":%q},"widgets":[{"id":"w1","type":"accounts","width":"half","accounts":{"mode":"account","account_id":%q}},{"id":"w2","type":"bucket_status","width":"full","bucket_status":{"mode":"bucket","bucket_id":%q}},{"id":"w3","type":"in_out","width":"half","in_out":{"figures":["income"],"period":"month","account_id":%q}},{"id":"w4","type":"bucket_status","width":"half","bucket_status":{"mode":"account","account_id":%q}}],"mobile_widgets":[{"id":"w1","type":"accounts","width":"full","accounts":{"mode":"account","account_id":%q}}]},"saved_modules":[{"id":"g1","name":"Food","period":"cycle-%s","module":{"id":"m-1","type":"graph","graph":{"kind":"bar","metric":"spending","resolution":"day","account_ids":[%q,%q],"bucket_ids":[%q]}}}]}`, a.ID, food.ID, b.ID, food.ID, a.ID, b.ID, a.ID, oct.ID, a.ID, b.ID, food.ID)
	if _, err := e.pool.Exec(ctx, `UPDATE users SET preferences = $2 WHERE id = $1`, userID, prefs); err != nil {
		t.Fatal(err)
	}
}

func (e env) read(t *testing.T, userID string) Data {
	t.Helper()
	var data Data
	err := pgx.BeginFunc(t.Context(), e.pool, func(tx pgx.Tx) error {
		var err error
		data, err = userdata.Read(t.Context(), tx, userID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRestore(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	alice := authtest.NewUser(t, e.pool, "alice").ID
	e.scenario(t, alice)
	before := e.read(t, alice)
	// The services ran on the debug clock: everything happened on its day.
	for _, id := range keys(before.Tables["transaction_headers"], "id") {
		if !strings.HasPrefix(id, "20261010") {
			t.Errorf("transaction %s isn't dated on the debug clock's day", id)
		}
	}

	snap, err := e.d.Save(ctx, alice, "Before the changes")
	if err != nil {
		t.Fatal(err)
	}
	if snap.UserID != alice || snap.Username != "alice" || !snap.TakenAt.Equal(e.d.Clock.Now()) || snap.Size == 0 {
		t.Errorf("snapshot %+v", snap)
	}

	// Change everything, and move the clock on.
	later := at("2026-10-20T08:00:00Z")
	if err := e.d.Clock.Set(ctx, &later, false); err != nil {
		t.Fatal(err)
	}
	cur := must[[]sqlc.Cycle](t)(e.cycles.List(ctx, alice))
	if _, err := e.cycles.End(ctx, alice, cur[0].ID, true); err != nil {
		t.Fatal(err)
	}
	must[accounts.Account](t)(e.accounts.Create(ctx, alice, accounts.New{Name: "New", OpeningBalance: dec("1")}))
	if _, err := e.pool.Exec(ctx, `UPDATE users SET preferences = '{}' WHERE id = $1`, alice); err != nil {
		t.Fatal(err)
	}

	takenAt, err := e.d.Restore(ctx, snap.ID, alice, true)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := asJSON(t, e.read(t, alice)), asJSON(t, before); got != want {
		t.Errorf("after the restore:\n%s\nwant\n%s", got, want)
	}
	if s := e.d.Clock.State(); s.Mode != Running || !takenAt.Equal(snap.TakenAt) || e.d.Clock.Now().Sub(takenAt) > time.Minute {
		t.Errorf("the clock should run from the snapshot's time: %+v, %v", s, e.d.Clock.Now())
	}
	checkForeignKeys(t, e.pool)

	// The services work on the restored data.
	if _, err := e.tx.List(ctx, alice, transactions.Filter{}); err != nil {
		t.Errorf("list after the restore: %v", err)
	}
	if n := countWhere(t, e.pool, "tags", "user_id = $1", alice); n != 3 {
		t.Errorf("tags: %d", n)
	}
	// New tags don't collide with restored ones.
	must[transactions.Transaction](t)(e.tx.Create(ctx, alice, transactions.New{
		Type: sqlc.TransactionTypeEXP, Counterparty: "Kiwi", Tags: []string{"new"}, AccountID: firstID(t, e.pool, alice), Amount: dec("1"),
	}))
}

func TestClone(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	alice := authtest.NewUser(t, e.pool, "alice").ID
	bob := authtest.NewUser(t, e.pool, "bob").ID
	e.scenario(t, alice)
	must[accounts.Account](t)(e.accounts.Create(ctx, bob, accounts.New{Name: "Bob's own", OpeningBalance: dec("5")}))
	aliceBefore := e.read(t, alice)

	snap, err := e.d.Save(ctx, alice, "Alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Restore(ctx, snap.ID, bob, false); err != nil {
		t.Fatal(err)
	}
	if got := asJSON(t, e.read(t, alice)); got != asJSON(t, aliceBefore) {
		t.Error("alice's data changed")
	}
	bobs := e.read(t, bob)
	for name, rows := range aliceBefore.Tables {
		if len(bobs.Tables[name]) != len(rows) {
			t.Errorf("%s: bob has %d rows, alice %d", name, len(bobs.Tables[name]), len(rows))
		}
	}
	if n := countWhere(t, e.pool, "bank_accounts", "user_id = $1 AND name = 'Bob''s own'", bob); n != 0 {
		t.Error("bob's own data should be replaced")
	}
	// No ID of alice's appears in bob's data.
	bobJSON := asJSON(t, bobs)
	for _, name := range []string{"bank_accounts", "cycles", "buckets", "transaction_headers", "schedules", "schedule_occurrences"} {
		if len(aliceBefore.Tables[name]) == 0 {
			t.Errorf("the scenario has no %s", name)
		}
		for _, id := range keys(aliceBefore.Tables[name], "id") {
			if strings.Contains(bobJSON, `"`+id+`"`) {
				t.Errorf("bob's data has alice's %s ID %s", name, id)
			}
		}
	}
	if strings.Contains(bobJSON, `"`+alice+`"`) {
		t.Error("bob's data mentions alice")
	}
	var prefs struct {
		Dashboard struct {
			Accounts struct {
				AccountID string `json:"account_id"`
			} `json:"accounts"`
			BucketStatus struct {
				BucketID string `json:"bucket_id"`
			} `json:"bucket_status"`
			Widgets []struct {
				Accounts struct {
					AccountID string `json:"account_id"`
				} `json:"accounts"`
				BucketStatus struct {
					AccountID string `json:"account_id"`
					BucketID  string `json:"bucket_id"`
				} `json:"bucket_status"`
				InOut struct {
					AccountID string `json:"account_id"`
				} `json:"in_out"`
			} `json:"widgets"`
			MobileWidgets []struct {
				Accounts struct {
					AccountID string `json:"account_id"`
				} `json:"accounts"`
			} `json:"mobile_widgets"`
		} `json:"dashboard"`
		SavedModules []struct {
			Period string `json:"period"`
			Module struct {
				Graph struct {
					AccountIDs []string `json:"account_ids"`
					BucketIDs  []string `json:"bucket_ids"`
				} `json:"graph"`
			} `json:"module"`
		} `json:"saved_modules"`
	}
	if err := json.Unmarshal(bobs.Preferences, &prefs); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.Dashboard.Accounts.AccountID) ||
		!slices.Contains(keys(bobs.Tables["buckets"], "id"), prefs.Dashboard.BucketStatus.BucketID) ||
		len(prefs.Dashboard.Widgets) != 4 ||
		len(prefs.Dashboard.MobileWidgets) != 1 ||
		!slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.Dashboard.MobileWidgets[0].Accounts.AccountID) ||
		!slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.Dashboard.Widgets[3].BucketStatus.AccountID) ||
		!slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.Dashboard.Widgets[2].InOut.AccountID) ||
		!slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.Dashboard.Widgets[0].Accounts.AccountID) ||
		!slices.Contains(keys(bobs.Tables["buckets"], "id"), prefs.Dashboard.Widgets[1].BucketStatus.BucketID) {
		t.Errorf("preferences point elsewhere: %s", bobs.Preferences)
	}
	if len(prefs.SavedModules) != 1 ||
		len(prefs.SavedModules[0].Module.Graph.AccountIDs) != 2 ||
		!slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.SavedModules[0].Module.Graph.AccountIDs[0]) ||
		!slices.Contains(keys(bobs.Tables["bank_accounts"], "id"), prefs.SavedModules[0].Module.Graph.AccountIDs[1]) ||
		len(prefs.SavedModules[0].Module.Graph.BucketIDs) != 1 ||
		!slices.Contains(keys(bobs.Tables["buckets"], "id"), prefs.SavedModules[0].Module.Graph.BucketIDs[0]) ||
		!slices.Contains(keys(bobs.Tables["cycles"], "id"), strings.TrimPrefix(prefs.SavedModules[0].Period, "cycle-")) {
		t.Errorf("saved modules point elsewhere: %s", bobs.Preferences)
	}
	checkForeignKeys(t, e.pool)

	// Bob's copy works like his own: the balances match alice's.
	balances := func(user string) []string {
		accts := must[[]accounts.Account](t)(e.accounts.List(ctx, user))
		var out []string
		for _, a := range accts {
			out = append(out, a.Name+" "+a.Balance.String())
		}
		slices.Sort(out)
		return out
	}
	if a, b := balances(alice), balances(bob); !slices.Equal(a, b) {
		t.Errorf("balances: alice %v, bob %v", a, b)
	}

	// An own snapshot whose IDs another user now has is cloned instead.
	bobSnap, err := e.d.Save(ctx, bob, "Bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `UPDATE debug_snapshots SET user_id = $1 WHERE id = $2`, alice, bobSnap.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Restore(ctx, bobSnap.ID, alice, false); err != nil {
		t.Fatalf("restore with taken IDs: %v", err)
	}
	checkForeignKeys(t, e.pool)
}

func TestSchemaVersion(t *testing.T) {
	e := setup(t)
	alice := authtest.NewUser(t, e.pool, "alice").ID
	snap, err := e.d.Save(t.Context(), alice, "Old")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(t.Context(), `UPDATE debug_snapshots SET schema_version = 1 WHERE id = $1`, snap.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Restore(t.Context(), snap.ID, alice, false); !errors.Is(err, ErrSchema) {
		t.Errorf("got %v, want ErrSchema", err)
	}
	if _, err := e.d.Restore(t.Context(), 999, alice, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("got %v, want ErrNotFound", err)
	}
}

func TestExportImport(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	alice := authtest.NewUser(t, e.pool, "alice").ID
	e.scenario(t, alice)
	before := e.read(t, alice)
	snap := must[Snapshot](t)(e.d.Save(ctx, alice, "Shared"))
	exp := must[Export](t)(e.d.Export(ctx, snap.ID))
	raw, err := json.Marshal(exp)
	if err != nil {
		t.Fatal(err)
	}

	var back Export
	if err := userdata.Decode(raw, &back); err != nil {
		t.Fatal(err)
	}
	imported := must[Snapshot](t)(e.d.Import(ctx, back))
	if imported.Name != "Shared" || imported.UserID != alice || imported.ID == snap.ID {
		t.Errorf("imported %+v", imported)
	}
	must[time.Time](t)(e.d.Restore(ctx, imported.ID, alice, false))
	if got := asJSON(t, e.read(t, alice)); got != asJSON(t, before) {
		t.Error("an imported snapshot restores the same data")
	}

	back.Data.Tables["users"] = nil
	if _, err := e.d.Import(ctx, back); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown table: %v", err)
	}
	if _, err := e.d.Import(ctx, Export{Format: 2}); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown format: %v", err)
	}
}

// checkForeignKeys fails the test if any foreign key is broken: restores run
// with the checks off.
func checkForeignKeys(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	rows, err := pool.Query(t.Context(), `
		SELECT c.conname, c.conrelid::regclass::text, c.confrelid::regclass::text,
		       (SELECT array_agg(attname ORDER BY k.i) FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
		        JOIN pg_attribute ON attrelid = c.conrelid AND attnum = k.n),
		       (SELECT array_agg(attname ORDER BY k.i) FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
		        JOIN pg_attribute ON attrelid = c.confrelid AND attnum = k.n)
		FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)
	if err != nil {
		t.Fatal(err)
	}
	type fk struct {
		Name, Table, Ref string
		Cols, RefCols    []string
	}
	fks, err := pgx.CollectRows(rows, pgx.RowToStructByPos[fk])
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range fks {
		var on []string
		for i := range f.Cols {
			on = append(on, fmt.Sprintf("p.%s = c.%s", f.RefCols[i], f.Cols[i]))
		}
		q := fmt.Sprintf(`SELECT count(*) FROM %s c WHERE (%s) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)`,
			f.Table, "c."+strings.Join(f.Cols, ", c."), f.Ref, strings.Join(on, " AND "))
		var n int
		if err := pool.QueryRow(t.Context(), q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		if n > 0 {
			t.Errorf("%s: %d broken references", f.Name, n)
		}
	}
}

func countWhere(t *testing.T, pool *pgxpool.Pool, table, where string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(t.Context(), fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s`, table, where), args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func firstID(t *testing.T, pool *pgxpool.Pool, userID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM bank_accounts WHERE user_id = $1 ORDER BY id LIMIT 1`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// keys returns the rows' values of col as text.
func keys(rows []userdata.Row, col string) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		if v := r[col]; v != nil {
			out = append(out, fmt.Sprint(v))
		}
	}
	return out
}
