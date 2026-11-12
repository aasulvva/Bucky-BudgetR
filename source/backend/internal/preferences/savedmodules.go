// Package preferences converts the stored shape of users' preferences when
// it changes: in the database (a migration) and in older export files
// (userdata's upgrade), with the same code.
package preferences

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// ConvertJSON decodes preferences (amounts and counts kept exact), converts
// them with conv and encodes them again. It reports whether conv changed
// anything; empty or null preferences are left as they are.
func ConvertJSON(raw []byte, conv func(map[string]any) bool) ([]byte, bool, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return raw, false, nil
	}
	var p map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return nil, false, fmt.Errorf("preferences: %w", err)
	}
	if !conv(p) {
		return raw, false, nil
	}
	out, err := json.Marshal(p)
	if err != nil {
		return nil, false, fmt.Errorf("preferences: %w", err)
	}
	return out, true, nil
}

// The old saved graphs' limit, for the way back.
const maxSavedGraphs = 50

// SavedModulesUp converts saved graphs (#122) and graph widgets (#124) to
// saved modules and module widgets (#201), in place: a saved graph
// {id, name, graph} becomes {id, name, period, module} with the graph's
// period as its own and the rest as a graph module "m-1"; a graph widget's
// saved_graph_id becomes a module widget's saved_module_id. The ids are
// kept, so widgets and links still find them. It reports whether anything
// changed; converted preferences don't change again.
func SavedModulesUp(p map[string]any) bool {
	changed := false
	if graphs, ok := p["saved_graphs"]; ok {
		list, _ := graphs.([]any)
		saved := make([]any, 0, len(list))
		for _, x := range list {
			g, _ := x.(map[string]any)
			graph, _ := g["graph"].(map[string]any)
			period, ok := graph["period"].(string)
			if !ok {
				continue // The API never stored one without a period.
			}
			settings := make(map[string]any, len(graph))
			for k, v := range graph {
				if k != "period" {
					settings[k] = v
				}
			}
			saved = append(saved, map[string]any{
				"id":     g["id"],
				"name":   g["name"],
				"period": period,
				"module": map[string]any{"id": "m-1", "type": "graph", "graph": settings},
			})
		}
		delete(p, "saved_graphs")
		if len(saved) > 0 {
			p["saved_modules"] = saved
		}
		changed = true
	}
	for _, w := range widgets(p) {
		if w["type"] != "graph" {
			continue
		}
		w["type"] = "module"
		if g, ok := w["graph"].(map[string]any); ok {
			if id, ok := g["saved_graph_id"]; ok {
				w["module"] = map[string]any{"saved_module_id": id}
			}
		}
		delete(w, "graph")
		changed = true
	}
	return changed
}

// SavedModulesDown is SavedModulesUp's way back, as far as it goes: saved
// graph modules become saved graphs again (without a comparison, breakdown
// or title, which saved graphs didn't have, and at most 50); other saved
// modules are dropped. Module widgets become graph widgets, so one that
// held another kind of module says its saved graph was deleted.
func SavedModulesDown(p map[string]any) bool {
	changed := false
	if modules, ok := p["saved_modules"]; ok {
		list, _ := modules.([]any)
		graphs := make([]any, 0, len(list))
		for _, x := range list {
			s, _ := x.(map[string]any)
			m, _ := s["module"].(map[string]any)
			settings, _ := m["graph"].(map[string]any)
			if m["type"] != "graph" || settings == nil || len(graphs) == maxSavedGraphs {
				continue
			}
			graph := make(map[string]any, len(settings)+1)
			for k, v := range settings {
				graph[k] = v
			}
			graph["period"] = s["period"]
			graphs = append(graphs, map[string]any{"id": s["id"], "name": s["name"], "graph": graph})
		}
		delete(p, "saved_modules")
		if len(graphs) > 0 {
			p["saved_graphs"] = graphs
		}
		changed = true
	}
	for _, w := range widgets(p) {
		if w["type"] != "module" {
			continue
		}
		w["type"] = "graph"
		if m, ok := w["module"].(map[string]any); ok {
			if id, ok := m["saved_module_id"]; ok {
				w["graph"] = map[string]any{"saved_graph_id": id}
			}
		}
		delete(w, "module")
		changed = true
	}
	return changed
}

// widgets is every widget in the desktop and mobile (#99) layouts.
func widgets(p map[string]any) []map[string]any {
	dashboard, _ := p["dashboard"].(map[string]any)
	var out []map[string]any
	for _, list := range []string{"widgets", "mobile_widgets"} {
		ws, _ := dashboard[list].([]any)
		for _, w := range ws {
			if w, ok := w.(map[string]any); ok {
				out = append(out, w)
			}
		}
	}
	return out
}
