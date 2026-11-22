package userdata

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ids"
)

// kind is the kind of ID a column holds.
type kind int

const (
	kUser kind = iota
	kAccount
	kCycle
	kBucket
	kTag
	kTransaction
	kBankLine
	kBucketLine
	kSchedule
	kOccurrence
	kHolder
	kSavingsLine
	kRule
	kBudget
	// kKept is kept as it is: a notification dismissal's key (#57). It names
	// IDs, so a clone's no longer match and are forgotten when its
	// notifications are next read.
	kKept
)

// idColumns lists, per table, every column that holds an ID and its kind.
// A clone gives each ID a new one. TestIDColumns checks it against the
// schema's foreign keys.
var idColumns = map[string]map[string]kind{
	"bank_accounts":           {"id": kAccount, "user_id": kUser},
	"cycles":                  {"id": kCycle, "user_id": kUser},
	"buckets":                 {"id": kBucket, "user_id": kUser, "source_account_id": kAccount, "overflow_target_id": kHolder},
	"tags":                    {"id": kTag, "user_id": kUser},
	"transaction_headers":     {"id": kTransaction, "user_id": kUser, "parent_id": kTransaction, "replaces_id": kTransaction, "created_by": kUser},
	"bank_transactions":       {"id": kBankLine, "transaction_id": kTransaction, "account_id": kAccount, "created_by": kUser},
	"bucket_transactions":     {"id": kBucketLine, "transaction_id": kTransaction, "bucket_id": kBucket, "cycle_id": kCycle, "created_by": kUser},
	"savings_holders":         {"id": kHolder, "user_id": kUser, "bucket_id": kBucket, "account_id": kAccount},
	"savings_rules":           {"id": kRule, "target_id": kHolder, "user_id": kUser},
	"savings_transactions":    {"id": kSavingsLine, "transaction_id": kTransaction, "holder_id": kHolder, "account_id": kAccount, "cycle_id": kCycle, "created_by": kUser},
	"transaction_tags":        {"transaction_id": kTransaction, "tag_id": kTag, "user_id": kUser},
	"refills":                 {"bucket_id": kBucket, "cycle_id": kCycle, "user_id": kUser, "ref_id": kTransaction, "ovf_id": kTransaction, "income_id": kTransaction},
	"savings_budget_entries":  {"id": kBudget, "user_id": kUser, "account_id": kAccount, "target_id": kHolder},
	"savings_budget_runs":     {"entry_id": kBudget, "cycle_id": kCycle, "user_id": kUser, "svr_id": kTransaction, "income_id": kTransaction},
	"savings_follow_ons":      {"source_id": kTransaction, "follow_id": kTransaction, "user_id": kUser},
	"schedules":               {"id": kSchedule, "user_id": kUser, "account_id": kAccount, "to_account_id": kAccount},
	"schedule_bucket_lines":   {"schedule_id": kSchedule, "bucket_id": kBucket, "user_id": kUser},
	"schedule_occurrences":    {"id": kOccurrence, "schedule_id": kSchedule, "user_id": kUser, "transaction_id": kTransaction},
	"notification_dismissals": {"user_id": kUser, "key": kKept},
}

// remap returns data with new IDs for userID: new accounts, cycles, buckets,
// savings targets and budget entries, tags, transactions, lines, schedules and occurrences,
// with every reference
// following. IDs are
// unique across users, so the new ones are checked against other users' rows.
func remap(ctx context.Context, tx pgx.Tx, userID string, data Data) (Data, error) {
	m := map[kind]map[string]string{}
	var err error
	if m[kAccount], err = newIDs(ctx, tx, userID, "bank_accounts", keys(data.Tables["bank_accounts"], "id"),
		func(string) string { return ids.NewAccount() }); err != nil {
		return Data{}, err
	}
	if m[kCycle], err = newIDs(ctx, tx, userID, "cycles", keys(data.Tables["cycles"], "id"),
		func(string) string { return ids.NewCycle(userID) }); err != nil {
		return Data{}, err
	}
	if m[kBucket], err = newIDs(ctx, tx, userID, "buckets", keys(data.Tables["buckets"], "id"),
		func(string) string { return ids.NewBucket(userID) }); err != nil {
		return Data{}, err
	}
	// A transaction ID starts with its date.
	at := map[string]time.Time{}
	for _, r := range data.Tables["transaction_headers"] {
		t, err := time.Parse(time.RFC3339Nano, fmt.Sprint(r["transaction_at"]))
		if err != nil {
			return Data{}, fmt.Errorf("%w: transaction %v: %w", ErrInvalid, r["id"], err)
		}
		at[fmt.Sprint(r["id"])] = t
	}
	if m[kTransaction], err = newIDs(ctx, tx, userID, "transaction_headers", keys(data.Tables["transaction_headers"], "id"),
		func(old string) string { return ids.NewTransaction(at[old]) }); err != nil {
		return Data{}, err
	}
	if m[kTag], err = newTagIDs(ctx, tx, keys(data.Tables["tags"], "id")); err != nil {
		return Data{}, err
	}
	if m[kSchedule], err = newIDs(ctx, tx, userID, "schedules", keys(data.Tables["schedules"], "id"),
		func(string) string { return ids.NewSchedule(userID) }); err != nil {
		return Data{}, err
	}
	if m[kHolder], err = newIDs(ctx, tx, userID, "savings_holders", keys(data.Tables["savings_holders"], "id"),
		func(string) string { return ids.NewSavingsHolder(userID) }); err != nil {
		return Data{}, err
	}
	if m[kBudget], err = newIDs(ctx, tx, userID, "savings_budget_entries", keys(data.Tables["savings_budget_entries"], "id"),
		func(string) string { return ids.NewSavingsBudgetEntry(userID) }); err != nil {
		return Data{}, err
	}
	// A rule's ID is its target's and 2 random digits: drawn unique per
	// target, as the new targets' IDs are unique.
	m[kRule] = map[string]string{}
	usedRule := map[string]bool{}
	for _, r := range data.Tables["savings_rules"] {
		holder, ok := m[kHolder][fmt.Sprint(r["target_id"])]
		if !ok {
			return Data{}, fmt.Errorf("%w: savings_rules.target_id %v refers to nothing in the snapshot", ErrInvalid, r["target_id"])
		}
		id := ids.NewSavingsRule(holder)
		for usedRule[id] {
			id = ids.NewSavingsRule(holder)
		}
		usedRule[id] = true
		m[kRule][fmt.Sprint(r["id"])] = id
	}
	m[kBankLine] = map[string]string{}
	m[kBucketLine] = map[string]string{}
	m[kOccurrence] = map[string]string{}
	m[kSavingsLine] = map[string]string{}

	out := Data{Tables: map[string][]row{}}
	for name, rows := range data.Tables {
		cols := idColumns[name]
		next := make([]row, len(rows))
		for i, r := range rows {
			n := maps.Clone(r)
			for col, k := range cols {
				v := r[col]
				if v == nil {
					continue
				}
				old := fmt.Sprint(v)
				switch k {
				case kKept:
				case kUser:
					n[col] = userID
				case kTag:
					n[col] = json.Number(m[kTag][old])
				case kBankLine:
					n[col] = lineID(m[kBankLine], old, func() string { return ids.NewBankLine(m[kAccount][fmt.Sprint(r["account_id"])]) })
				case kBucketLine:
					n[col] = lineID(m[kBucketLine], old, func() string { return ids.NewBucketLine(m[kBucket][fmt.Sprint(r["bucket_id"])]) })
				case kSavingsLine:
					n[col] = lineID(m[kSavingsLine], old, func() string { return ids.NewSavingsLine(m[kHolder][fmt.Sprint(r["holder_id"])]) })
				case kOccurrence:
					n[col] = lineID(m[kOccurrence], old, func() string { return ids.NewOccurrence(m[kSchedule][fmt.Sprint(r["schedule_id"])]) })
				default:
					id, ok := m[k][old]
					if !ok {
						return Data{}, fmt.Errorf("%w: %s.%s %s refers to nothing in the snapshot", ErrInvalid, name, col, old)
					}
					n[col] = id
				}
			}
			next[i] = n
		}
		out.Tables[name] = next
	}
	prefs, err := remapPreferences(data.Preferences, m)
	if err != nil {
		return Data{}, err
	}
	out.Preferences = prefs
	return out, nil
}

// lineID returns a new ID for the line old. Lines are only referred to by
// their own row, but the map keeps a line's ID the same if it repeats.
func lineID(m map[string]string, old string, gen func() string) string {
	if id, ok := m[old]; ok {
		return id
	}
	id := gen()
	m[old] = id
	return id
}

// newIDs maps each old ID of table to a new one from gen that no other user
// has (the user's own rows are about to be replaced) and that is unique among
// the new ones.
func newIDs(ctx context.Context, tx pgx.Tx, userID, table string, old []string, gen func(old string) string) (map[string]string, error) {
	m := make(map[string]string, len(old))
	used := map[string]bool{}
	pending := old
	for range 10 {
		for _, o := range pending {
			id := gen(o)
			for used[id] {
				id = gen(o)
			}
			m[o], used[id] = id, true
		}
		var taken []string
		err := tx.QueryRow(ctx, fmt.Sprintf(`
			SELECT coalesce(array_agg(id), '{}') FROM %s WHERE id = ANY($1) AND user_id <> $2`, table),
			slices.Collect(maps.Values(m)), userID).Scan(&taken)
		if err != nil {
			return nil, fmt.Errorf("new %s IDs: %w", table, err)
		}
		if len(taken) == 0 {
			return m, nil
		}
		pending = pending[:0:0]
		for o, id := range m {
			if slices.Contains(taken, id) {
				pending = append(pending, o)
			}
		}
	}
	return nil, fmt.Errorf("new %s IDs: no free IDs found", table)
}

// newTagIDs maps each old tag ID to a new one from the tags' sequence.
func newTagIDs(ctx context.Context, tx pgx.Tx, old []string) (map[string]string, error) {
	m := make(map[string]string, len(old))
	if len(old) == 0 {
		return m, nil
	}
	var fresh []int64
	err := tx.QueryRow(ctx, `
		SELECT array_agg(nextval(pg_get_serial_sequence('tags', 'id'))) FROM generate_series(1, $1)`, len(old)).Scan(&fresh)
	if err != nil {
		return nil, fmt.Errorf("new tag IDs: %w", err)
	}
	for i, o := range old {
		m[o] = fmt.Sprint(fresh[i])
	}
	return m, nil
}

// remapPreferences changes the IDs in the preferences that hold them (the
// dashboard's settings and layouts, saved modules and report templates) to
// the new ones. An ID that isn't in the snapshot is left as it is; the app
// ignores unknown IDs.
func remapPreferences(raw json.RawMessage, m map[kind]map[string]string) (json.RawMessage, error) {
	var prefs map[string]any
	if err := Decode(raw, &prefs); err != nil {
		return nil, fmt.Errorf("%w: preferences: %w", ErrInvalid, err)
	}
	dashboard, _ := prefs["dashboard"].(map[string]any)
	// The per-type settings from before #37, and each widget in the desktop
	// and mobile (#99) layouts.
	holders := []map[string]any{dashboard}
	for _, list := range []string{"widgets", "mobile_widgets"} {
		widgets, _ := dashboard[list].([]any)
		for _, w := range widgets {
			if w, ok := w.(map[string]any); ok {
				holders = append(holders, w)
			}
		}
	}
	for _, h := range holders {
		for _, p := range []struct {
			widget, field string
			kind          kind
		}{
			{"accounts", "account_id", kAccount},
			{"bucket_status", "account_id", kAccount},
			{"bucket_status", "bucket_id", kBucket},
			{"in_out", "account_id", kAccount},
		} {
			w, _ := h[p.widget].(map[string]any)
			if old, ok := w[p.field].(string); ok {
				if id, ok := m[p.kind][old]; ok {
					w[p.field] = id
				}
			}
		}
	}
	// Saved modules (#201) and report templates (#125) filter on lists of
	// accounts and buckets, and may name a specific cycle. Module widgets
	// name saved modules by their own ids, which stay.
	saved, _ := prefs["saved_modules"].([]any)
	for _, s := range saved {
		s, _ := s.(map[string]any)
		remapGraph(m, s) // Its period.
		remapModules(m, []any{s["module"]})
	}
	templates, _ := prefs["report_templates"].([]any)
	for _, r := range templates {
		r, _ := r.(map[string]any)
		report, _ := r["report"].(map[string]any)
		remapGraph(m, report)
		modules, _ := report["modules"].([]any)
		remapModules(m, modules)
	}
	return json.Marshal(prefs)
}

// remapModules remaps report modules' filters in place, those in a
// section's (#194) too.
func remapModules(m map[kind]map[string]string, modules []any) {
	for _, mod := range modules {
		mod, _ := mod.(map[string]any)
		remapGraph(m, mod["graph"])
		remapGraph(m, mod["transactions"]) // Its filters, as a graph's (#126).
		remapGraph(m, mod["flows"])
		remapGraph(m, mod["budget"])
		section, _ := mod["section"].(map[string]any)
		inner, _ := section["modules"].([]any)
		remapModules(m, inner)
	}
}

// remapGraph remaps a graph's or report's period (cycle-<id>) and its
// account and bucket filters, in place.
func remapGraph(m map[kind]map[string]string, v any) {
	settings, _ := v.(map[string]any)
	if settings == nil {
		return
	}
	if period, ok := settings["period"].(string); ok {
		if old, ok := strings.CutPrefix(period, "cycle-"); ok {
			if id, ok := m[kCycle][old]; ok {
				settings["period"] = "cycle-" + id
			}
		}
	}
	for field, k := range map[string]kind{"account_ids": kAccount, "bucket_ids": kBucket} {
		ids, _ := settings[field].([]any)
		for i, old := range ids {
			if old, ok := old.(string); ok {
				if id, ok := m[k][old]; ok {
					ids[i] = id
				}
			}
		}
	}
}
