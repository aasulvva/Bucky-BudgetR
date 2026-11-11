package preferences_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/preferences"
)

// Before #201: two saved graphs, a graph widget per layout (one without
// settings) and other preferences that don't change.
const before = `{
  "locale": "nb-NO",
  "saved_graphs": [
    {"id": "g-1", "name": "Food", "graph": {"kind": "bar", "metric": "spending", "period": "last-30-days", "resolution": "day", "bucket_ids": ["1000000001"], "top": 3}},
    {"id": "g-3", "name": "Cycle", "graph": {"kind": "pie", "metric": "spending", "period": "cycle-100001000002", "resolution": "total", "group_by": "bucket"}}
  ],
  "report_templates": [{"id": "r-1", "name": "Year", "report": {"period": "previous-year", "modules": []}}],
  "dashboard": {
    "widgets": [
      {"id": "w1", "type": "accounts", "width": "half"},
      {"id": "w2", "type": "graph", "width": "full", "title": "Mine", "graph": {"saved_graph_id": "g-3"}}
    ],
    "mobile_widgets": [{"id": "w3", "type": "graph", "width": "full"}]
  }
}`

const after = `{
  "locale": "nb-NO",
  "saved_modules": [
    {"id": "g-1", "name": "Food", "period": "last-30-days", "module": {"id": "m-1", "type": "graph", "graph": {"kind": "bar", "metric": "spending", "resolution": "day", "bucket_ids": ["1000000001"], "top": 3}}},
    {"id": "g-3", "name": "Cycle", "period": "cycle-100001000002", "module": {"id": "m-1", "type": "graph", "graph": {"kind": "pie", "metric": "spending", "resolution": "total", "group_by": "bucket"}}}
  ],
  "report_templates": [{"id": "r-1", "name": "Year", "report": {"period": "previous-year", "modules": []}}],
  "dashboard": {
    "widgets": [
      {"id": "w1", "type": "accounts", "width": "half"},
      {"id": "w2", "type": "module", "width": "full", "title": "Mine", "module": {"saved_module_id": "g-3"}}
    ],
    "mobile_widgets": [{"id": "w3", "type": "module", "width": "full"}]
  }
}`

func convert(t *testing.T, raw string, conv func(map[string]any) bool) (string, bool) {
	t.Helper()
	out, changed, err := preferences.ConvertJSON([]byte(raw), conv)
	if err != nil {
		t.Fatal(err)
	}
	return string(out), changed
}

// equalJSON compares two JSON texts as values.
func equalJSON(t *testing.T, got, want string) {
	t.Helper()
	var a, b any
	if err := json.Unmarshal([]byte(got), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatal(err)
	}
	ga, _ := json.Marshal(a)
	gb, _ := json.Marshal(b)
	if !bytes.Equal(ga, gb) {
		t.Errorf("got\n%s\nwant\n%s", ga, gb)
	}
}

func TestSavedModulesUp(t *testing.T) {
	got, changed := convert(t, before, preferences.SavedModulesUp)
	if !changed {
		t.Fatal("nothing changed")
	}
	equalJSON(t, got, after)

	// Once is enough.
	if again, changed := convert(t, got, preferences.SavedModulesUp); changed || again != got {
		t.Errorf("converted again: %s", again)
	}
	// Nothing to convert, or nothing at all.
	for _, raw := range []string{`{"locale":"en-GB"}`, `{}`, `null`, ``} {
		if out, changed := convert(t, raw, preferences.SavedModulesUp); changed || out != raw {
			t.Errorf("%q changed to %q", raw, out)
		}
	}
	// Empty and malformed lists: gone, and nothing panics.
	got, _ = convert(t, `{"saved_graphs":[],"dashboard":{"widgets":"x"}}`, preferences.SavedModulesUp)
	equalJSON(t, got, `{"dashboard":{"widgets":"x"}}`)
	got, _ = convert(t, `{"saved_graphs":[1,{"id":"g-1","name":"x","graph":{}}],"dashboard":{"widgets":[2,{"type":"graph","graph":3}]}}`, preferences.SavedModulesUp)
	equalJSON(t, got, `{"dashboard":{"widgets":[2,{"type":"module"}]}}`)
}

func TestSavedModulesDown(t *testing.T) {
	// The way back gives what there was.
	up, _ := convert(t, before, preferences.SavedModulesUp)
	down, changed := convert(t, up, preferences.SavedModulesDown)
	if !changed {
		t.Fatal("nothing changed")
	}
	equalJSON(t, down, before)

	// Other modules, and what saved graphs didn't have, are dropped.
	got, _ := convert(t, `{"saved_modules":[
	  {"id":"g-1","name":"List","period":"last-3-months","module":{"id":"m-1","type":"transactions","transactions":{}}},
	  {"id":"g-2","name":"Pay","period":"previous-month","compare_to":"last_year","module":{"id":"m-1","type":"graph","title":"Pay","compare":"both","graph":{"kind":"bar","metric":"income","resolution":"day"}}}
	],"dashboard":{"widgets":[{"id":"w1","type":"module","width":"full","module":{"saved_module_id":"g-1"}}]}}`, preferences.SavedModulesDown)
	equalJSON(t, got, `{"saved_graphs":[
	  {"id":"g-2","name":"Pay","graph":{"kind":"bar","metric":"income","period":"previous-month","resolution":"day"}}
	],"dashboard":{"widgets":[{"id":"w1","type":"graph","width":"full","graph":{"saved_graph_id":"g-1"}}]}}`)
}

func TestConvertJSONKeepsNumbers(t *testing.T) {
	raw := `{"income_refill_rules":[{"amount":1000.10}],"saved_graphs":[]}`
	got, _ := convert(t, raw, preferences.SavedModulesUp)
	if !bytes.Contains([]byte(got), []byte(`1000.10`)) {
		t.Errorf("the amount changed: %s", got)
	}
}
