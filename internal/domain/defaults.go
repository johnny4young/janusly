// Declared-default resolution, ported from applyInputDefaults in
// packages/engine/src/inputs-validator.ts. The JavaScript undefined/null
// distinction maps to (value, present): an absent field takes its default,
// while explicit null and false are supplied values and always win.
package domain

import "maps"

// ApplyInputDefaults fills declared defaults into a run-start payload and
// returns a new value; the caller's payload is never mutated. Run it BEFORE
// validation: it is what lets a workflow declare a required setting and
// still start from a trigger, whose payload carries the event rather than
// the declared fields.
func ApplyInputDefaults(schema *InputSchema, value any) any {
	resolved, _ := applyDefaults(schema, value, value != nil)
	return resolved
}

func applyDefaults(schema *InputSchema, value any, present bool) (any, bool) {
	if schema.Type != "object" {
		if !present {
			return schema.DefaultValue(), schema.HasDefault()
		}
		return value, true
	}

	// Pick what to fill into. A wrong-typed supplied value or default passes
	// through untouched so validation reports the type error rather than this
	// function silently reshaping it.
	base := value
	basePresent := present
	if !present {
		base = schema.DefaultValue()
		basePresent = schema.HasDefault()
	}
	if basePresent {
		if _, ok := base.(map[string]any); !ok {
			return base, true
		}
	}

	filled := map[string]any{}
	if baseMap, ok := base.(map[string]any); ok {
		maps.Copy(filled, baseMap)
	}
	// Sorted for determinism; the reference iterates declaration order, and
	// the parity harness compares results, not fill order. Prototype-shaped
	// keys like __proto__ are plain map data in Go — the hardening the
	// reference needs against Object.prototype comes for free here.
	for _, key := range sortedKeys(schema.Properties) {
		supplied, has := filled[key]
		resolved, ok := applyDefaults(schema.Properties[key], supplied, has)
		if ok {
			filled[key] = resolved
		}
	}
	// An absent optional object stays absent unless a child default gave it
	// content — otherwise every optional section would materialize as {}.
	if !basePresent && len(filled) == 0 {
		return nil, false
	}
	return filled, true
}
