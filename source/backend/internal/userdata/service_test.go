package userdata_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

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
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/testdb"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/transactions"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/userdata"
)

var now = time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)

func clock() time.Time { return now }

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

type env struct {
	pool     *pgxpool.Pool
	svc      *userdata.Service
	accounts *accounts.Service
	buckets  *buckets.Service
	cycles   *cycles.Service
	tx       *transactions.Service
}

func setup(t *testing.T) env {
	t.Helper()
	pool := testdb.New(t)
	l := ledger.New(ledger.Options{AfterRecord: allocation.AfterRecord})
	r := refill.NewService(pool, l, refill.Options{Now: clock})
	return env{
		pool:     pool,
		svc:      userdata.NewService(pool, userdata.Options{Now: clock}),
		accounts: accounts.NewService(pool, l, accounts.Options{Now: clock}),
		buckets:  buckets.NewService(pool, l, buckets.Options{Now: clock, OnCreate: r.OnCreate}),
		cycles:   cycles.NewService(pool, cycles.Options{Now: clock, OnEnd: r.OnEnd, OnStart: r.OnStart}),
		tx:       transactions.NewService(pool, l, transactions.Options{Now: clock, Refills: r}),
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

// scenario gives the user a running cycle, an account with a refilled
// bucket, a tagged expense and its correction, and a dashboard pointing at
// the account. It returns the account.
func (e env) scenario(t *testing.T, userID string) accounts.Account {
	t.Helper()
	ctx := t.Context()
	oct := must[sqlc.Cycle](t)(e.cycles.Create(ctx, userID, now.Add(-24*time.Hour), now.Add(20*24*time.Hour)))
	must[sqlc.Cycle](t)(e.cycles.Start(ctx, userID, oct.ID))
	a := must[accounts.Account](t)(e.accounts.Create(ctx, userID, accounts.New{Name: "Main", OpeningBalance: dec("1000.10"), Bank: "DNB"}))
	food := must[buckets.Bucket](t)(e.buckets.Create(ctx, userID, buckets.New{
		Name: "Food", SourceAccountID: a.ID, RefillAmount: dec("300"), CapMultiplier: dec("1"), Refill: true,
	}))
	exp := must[transactions.Transaction](t)(e.tx.Create(ctx, userID, transactions.New{
		Type: sqlc.TransactionTypeEXP, Counterparty: "Rema", Tags: []string{"food"}, AccountID: a.ID,
		Amount: dec("150"), Buckets: []transactions.BucketAmount{{BucketID: food.ID, Amount: dec("150")}},
	}))
	amount := dec("120.55")
	must[transactions.Transaction](t)(e.tx.Correct(ctx, userID, exp.ID, transactions.Changes{
		Amount: &amount, SetBuckets: true, Buckets: []transactions.BucketAmount{{BucketID: food.ID, Amount: amount}},
	}))
	prefs := fmt.Sprintf(`{"locale":"nb-NO","dashboard":{"widgets":[{"id":"w1","type":"accounts","width":"half","accounts":{"mode":"account","account_id":%[1]q}}]},`+
		`"report_templates":[{"id":"r1","name":"Cycle","report":{"period":"cycle-%[2]s","account_ids":[%[1]q],"modules":[{"id":"m1","type":"graph","graph":{"kind":"pie","metric":"spending","resolution":"total","bucket_ids":[%[3]q]}},{"id":"m2","type":"transactions","transactions":{"account_ids":[%[1]q],"bucket_ids":[%[3]q]}},{"id":"m3","type":"flows","flows":{"bucket_ids":[%[3]q]}},{"id":"m4","type":"budget","budget":{"account_ids":[%[1]q],"bucket_ids":[%[3]q]}},`+
		`{"id":"m5","type":"section","section":{"unit":"month","modules":[{"id":"m6","type":"transactions","transactions":{"account_ids":[%[1]q],"bucket_ids":[%[3]q]}}]}}]}}]}`,
		a.ID, oct.ID, food.ID)
	if _, err := e.pool.Exec(ctx, `UPDATE users SET preferences = $2 WHERE id = $1`, userID, prefs); err != nil {
		t.Fatal(err)
	}
	return a
}

// file exports the user's data and reads it back as a file would be.
func (e env) file(t *testing.T, userID string) (userdata.File, []byte) {
	t.Helper()
	f := must[userdata.File](t)(e.svc.Export(t.Context(), userID))
	raw, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	return must[userdata.File](t)(userdata.ParseFile(raw)), raw
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestExportImport(t *testing.T) {
	e := setup(t)
	ctx := t.Context()
	alice := authtest.NewUser(t, e.pool, "alice")
	a := e.scenario(t, alice.ID)

	f, raw := e.file(t, alice.ID)
	if f.App != userdata.App || f.Format != userdata.Format || f.Username != "alice" || f.UserID != alice.ID ||
		f.SchemaVersion < 23 || !f.ExportedAt.Equal(now) {
		t.Errorf("file header %+v", f)
	}
	// Exact, trailing zeros included; the correction is the change (29.45).
	if !strings.Contains(string(raw), `"amount":1000.10`) || !strings.Contains(string(raw), `"amount":29.45`) {
		t.Errorf("amounts aren't exact: %s", raw)
	}

	t.Run("replaces the user's own data, keeping the IDs", func(t *testing.T) {
		must[transactions.Transaction](t)(e.tx.Create(ctx, alice.ID, transactions.New{
			Type: sqlc.TransactionTypeINC, Counterparty: "Later", AccountID: a.ID, Amount: dec("5"),
		}))
		must[accounts.Account](t)(e.accounts.Create(ctx, alice.ID, accounts.New{Name: "Later", OpeningBalance: dec("1")}))

		c := must[userdata.Counts](t)(e.svc.Import(ctx, alice.ID, f))
		// The opening balance, the refill and the expense, not its correction.
		if c != (userdata.Counts{Accounts: 1, Buckets: 1, Cycles: 1, Transactions: 3, Schedules: 0}) {
			t.Errorf("counts %+v", c)
		}
		again, _ := e.file(t, alice.ID)
		if got, want := asJSON(t, again.Data), asJSON(t, f.Data); got != want {
			t.Errorf("after the import:\n%s\nwant\n%s", got, want)
		}
	})

	t.Run("copies another user's data with new IDs", func(t *testing.T) {
		bob := authtest.NewUser(t, e.pool, "bob")
		must[userdata.Counts](t)(e.svc.Import(ctx, bob.ID, f))
		got, _ := e.file(t, bob.ID)
		account := got.Data.Tables["bank_accounts"][0]
		if account["id"] == a.ID || account["user_id"] != bob.ID || account["bank"] != "DNB" {
			t.Errorf("bob's account %v", account)
		}
		if !strings.Contains(string(got.Data.Preferences), fmt.Sprint(account["id"])) {
			t.Errorf("the dashboard doesn't follow: %s", got.Data.Preferences)
		}
		// Report templates (#125) follow too: the period's cycle, the
		// report's accounts and the modules' buckets.
		var prefs struct {
			ReportTemplates []struct {
				Report struct {
					Period     string   `json:"period"`
					AccountIDs []string `json:"account_ids"`
					Modules    []struct {
						Graph struct {
							BucketIDs []string `json:"bucket_ids"`
						} `json:"graph"`
						Transactions struct {
							AccountIDs []string `json:"account_ids"`
							BucketIDs  []string `json:"bucket_ids"`
						} `json:"transactions"`
						Flows struct {
							BucketIDs []string `json:"bucket_ids"`
						} `json:"flows"`
						Budget struct {
							AccountIDs []string `json:"account_ids"`
							BucketIDs  []string `json:"bucket_ids"`
						} `json:"budget"`
						Section struct {
							Modules []struct {
								Transactions struct {
									AccountIDs []string `json:"account_ids"`
									BucketIDs  []string `json:"bucket_ids"`
								} `json:"transactions"`
							} `json:"modules"`
						} `json:"section"`
					} `json:"modules"`
				} `json:"report"`
			} `json:"report_templates"`
		}
		if err := json.Unmarshal(got.Data.Preferences, &prefs); err != nil {
			t.Fatal(err)
		}
		r := prefs.ReportTemplates[0].Report
		if r.Period != "cycle-"+fmt.Sprint(got.Data.Tables["cycles"][0]["id"]) ||
			r.AccountIDs[0] != account["id"] ||
			r.Modules[0].Graph.BucketIDs[0] != got.Data.Tables["buckets"][0]["id"] ||
			r.Modules[1].Transactions.AccountIDs[0] != account["id"] ||
			r.Modules[1].Transactions.BucketIDs[0] != got.Data.Tables["buckets"][0]["id"] ||
			r.Modules[2].Flows.BucketIDs[0] != got.Data.Tables["buckets"][0]["id"] ||
			r.Modules[3].Budget.AccountIDs[0] != account["id"] ||
			r.Modules[3].Budget.BucketIDs[0] != got.Data.Tables["buckets"][0]["id"] ||
			// A section's modules too (#207).
			r.Modules[4].Section.Modules[0].Transactions.AccountIDs[0] != account["id"] ||
			r.Modules[4].Section.Modules[0].Transactions.BucketIDs[0] != got.Data.Tables["buckets"][0]["id"] {
			t.Errorf("bob's report template %+v", r)
		}
		// Alice's data is untouched.
		if mine, _ := e.file(t, alice.ID); asJSON(t, mine.Data) != asJSON(t, f.Data) {
			t.Error("alice's data changed")
		}
	})

	t.Run("an older file gets the defaults of newer columns", func(t *testing.T) {
		old := f
		old.Data.Tables = map[string][]userdata.Row{}
		for name, rows := range f.Data.Tables {
			for _, r := range rows {
				n := map[string]any{}
				for k, v := range r {
					if name != "bank_accounts" || k != "bank" {
						n[k] = v
					}
				}
				old.Data.Tables[name] = append(old.Data.Tables[name], n)
			}
		}
		must[userdata.Counts](t)(e.svc.Import(ctx, alice.ID, old))
		got, _ := e.file(t, alice.ID)
		if b := got.Data.Tables["bank_accounts"][0]["bank"]; b != "" {
			t.Errorf("bank %v, want the default ''", b)
		}
		must[userdata.Counts](t)(e.svc.Import(ctx, alice.ID, f))
	})

	t.Run("refuses what it can't read, changing nothing", func(t *testing.T) {
		unknownColumn := f
		unknownColumn.Data.Tables = map[string][]userdata.Row{}
		for name, rows := range f.Data.Tables {
			unknownColumn.Data.Tables[name] = slices.Clone(rows)
		}
		unknownColumn.Data.Tables["cycles"] = []userdata.Row{{"id": "x", "from_the_future": true}}
		unknownTable := f
		unknownTable.Data.Tables = map[string][]userdata.Row{"secrets": {}}
		for name, file := range map[string]userdata.File{"column": unknownColumn, "table": unknownTable} {
			if _, err := e.svc.Import(ctx, alice.ID, file); !errors.Is(err, userdata.ErrInvalid) {
				t.Errorf("unknown %s: got %v, want ErrInvalid", name, err)
			}
		}
		if got, _ := e.file(t, alice.ID); asJSON(t, got.Data) != asJSON(t, f.Data) {
			t.Error("a refused import changed something")
		}

		newer := strings.Replace(string(raw), fmt.Sprintf(`"format":%d`, userdata.Format), `"format":99`, 1)
		if _, err := userdata.ParseFile([]byte(newer)); !errors.Is(err, userdata.ErrNewer) {
			t.Errorf("newer format: got %v", err)
		}
		for _, bad := range []string{`{"app":"other","format":1,"user_id":"1"}`, `[1,2]`, `{"app":"bucky-budgetr","format":0,"user_id":"1"}`} {
			if _, err := userdata.ParseFile([]byte(bad)); !errors.Is(err, userdata.ErrInvalid) {
				t.Errorf("%s: got %v", bad, err)
			}
		}
	})

	t.Run("the ledger stays immutable outside an import", func(t *testing.T) {
		if _, err := e.pool.Exec(ctx, `DELETE FROM bank_transactions`); err == nil ||
			!strings.Contains(err.Error(), "immutable") {
			t.Errorf("delete outside an import: %v", err)
		}
		if _, err := e.pool.Exec(ctx, `SET bucky.replacing_user_data = 'on'; UPDATE transaction_headers SET counterparty = 'x'`); err == nil {
			t.Error("an update went through")
		}
	})
}
