// Layered resolution over the closed catalog: valid tenant row → env
// override → catalog default, per key. Pure — callers hand in the tenant
// rows and an env lookup so tests drive every layer deterministically.
package orgconfig

import (
	"encoding/json"
	"strconv"
)

// Resolved is one catalog entry with its effective value and provenance.
type Resolved struct {
	Definition
	Value  any    `json:"value"`
	Source string `json:"source"` // "tenant" | "env" | "default"
}

// ResolveAll maps every catalog definition to its effective value.
// tenantRows carries the org's raw value_json by key; lookupEnv is the
// process environment seam.
func ResolveAll(tenantRows map[string]json.RawMessage, lookupEnv func(string) (string, bool)) []Resolved {
	out := make([]Resolved, 0, len(Definitions))
	for i := range Definitions {
		def := &Definitions[i]
		value, source := resolveOne(def, tenantRows, lookupEnv)
		out = append(out, Resolved{Definition: *def, Value: value, Source: source})
	}
	return out
}

// ResolveValue resolves a single key through the same chain. Unknown keys
// return (nil, "").
func ResolveValue(key string, tenantRows map[string]json.RawMessage, lookupEnv func(string) (string, bool)) (any, string) {
	def := Get(key)
	if def == nil {
		return nil, ""
	}
	return resolveOne(def, tenantRows, lookupEnv)
}

func resolveOne(def *Definition, tenantRows map[string]json.RawMessage, lookupEnv func(string) (string, bool)) (any, string) {
	if raw, ok := tenantRows[def.Key]; ok {
		if value, ok := parseStored(def, raw); ok {
			return value, "tenant"
		}
	}
	for _, envKey := range def.EnvKeys {
		raw, ok := lookupEnv(envKey)
		if !ok || raw == "" {
			continue
		}
		if value, ok := parseEnv(def, raw); ok {
			return value, "env"
		}
	}
	return def.Default, "default"
}

// parseStored decodes a tenant row's value_json into the definition's
// type; a mismatched or malformed row falls through to the next layer.
func parseStored(def *Definition, raw json.RawMessage) (any, bool) {
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false
	}
	value, err := Normalize(def, decoded)
	return value, err == nil
}

// parseEnv interprets an env string per the definition's type; invalid or
// out-of-range values fall through to the default (the contract's
// posture: a bad env never half-applies).
func parseEnv(def *Definition, raw string) (any, bool) {
	switch def.ValueType {
	case "boolean":
		if raw == "true" {
			value, err := Normalize(def, true)
			return value, err == nil
		}
		if raw == "false" {
			value, err := Normalize(def, false)
			return value, err == nil
		}
		return nil, false
	case "number":
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return nil, false
		}
		value, err := Normalize(def, parsed)
		return value, err == nil
	default:
		value, err := Normalize(def, raw)
		return value, err == nil
	}
}
