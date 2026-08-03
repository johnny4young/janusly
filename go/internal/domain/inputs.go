// Declared-input schema subset and its validator, ported from
// packages/engine/src/inputs-validator.ts. Message strings are part of the
// contract: they surface verbatim in validation issues and API errors.
package domain

import (
	"encoding/json"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
)

// InputSchema is the JSON-Schema subset a workflow declares for its inputs.
// Default is kept raw so an absent default and an explicit null default stay
// distinguishable, exactly like `undefined` versus `null` in the reference.
type InputSchema struct {
	Type        string                  `json:"type"`
	Description string                  `json:"description,omitempty"`
	Properties  map[string]*InputSchema `json:"properties,omitempty"`
	Required    []string                `json:"required,omitempty"`
	Items       *InputSchema            `json:"items,omitempty"`
	Enum        []any                   `json:"enum,omitempty"`
	Default     json.RawMessage         `json:"default,omitempty"`
}

// ParseInputSchemaValue projects a decoded JSON value into the shared schema
// subset and rejects unknown type tags anywhere in the recursive tree.
func ParseInputSchemaValue(value any) (*InputSchema, bool) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	var schema InputSchema
	if err := json.Unmarshal(raw, &schema); err != nil || !validInputSchemaShape(&schema) {
		return nil, false
	}
	return &schema, true
}

func validInputSchemaShape(schema *InputSchema) bool {
	switch schema.Type {
	case "string", "number", "boolean":
		return true
	case "object":
		for _, child := range schema.Properties {
			if child == nil || !validInputSchemaShape(child) {
				return false
			}
		}
		return true
	case "array":
		return schema.Items == nil || validInputSchemaShape(schema.Items)
	default:
		return false
	}
}

// HasDefault reports whether a default was declared at all.
func (s *InputSchema) HasDefault() bool { return len(s.Default) > 0 }

// DefaultValue decodes the declared default. Only meaningful when HasDefault.
func (s *InputSchema) DefaultValue() any {
	var v any
	_ = json.Unmarshal(s.Default, &v)
	return v
}

// ValidateInputValue walks the schema and aggregates every violation in one
// pass, so callers get the complete picture instead of the first failure.
func ValidateInputValue(schema *InputSchema, value any, path string) []string {
	var errs []string
	walkInput(schema, value, path, &errs)
	return errs
}

func walkInput(schema *InputSchema, value any, path string, errs *[]string) {
	if !matchesInputType(schema.Type, value) {
		*errs = append(*errs, fmt.Sprintf("%s must be %s, got %s", path, schema.Type, describeActual(value)))
		return
	}

	if len(schema.Enum) > 0 {
		matched := false
		for _, allowed := range schema.Enum {
			if reflect.DeepEqual(allowed, value) {
				matched = true
				break
			}
		}
		if !matched {
			allowedJSON, _ := json.Marshal(schema.Enum)
			valueJSON, _ := json.Marshal(value)
			*errs = append(*errs, fmt.Sprintf("%s must be one of %s, got %s", path, allowedJSON, valueJSON))
		}
	}

	if schema.Type == "object" {
		obj, _ := value.(map[string]any)
		for _, requiredKey := range schema.Required {
			if _, ok := obj[requiredKey]; !ok {
				*errs = append(*errs, fmt.Sprintf("%s.%s is required", path, requiredKey))
			}
		}
		// Sorted iteration keeps the aggregated error order deterministic;
		// Go maps would otherwise shuffle it between runs.
		for _, propName := range sortedKeys(schema.Properties) {
			if propValue, ok := obj[propName]; ok {
				walkInput(schema.Properties[propName], propValue, path+"."+propName, errs)
			}
		}
	}

	if schema.Type == "array" && schema.Items != nil {
		for i, item := range value.([]any) {
			walkInput(schema.Items, item, fmt.Sprintf("%s[%d]", path, i), errs)
		}
	}
}

func matchesInputType(schemaType string, value any) bool {
	switch schemaType {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	}
	return false
}

func describeActual(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	}
	return "unknown"
}

// invalidDefault pairs a schema path with why its declared default fails.
type invalidDefault struct {
	Path    string
	Problem string
}

// invalidInputDefaults checks every declared default against the field it
// defaults, recursing through object properties so nested settings report at
// their own path.
func invalidInputDefaults(schema *InputSchema, path string) []invalidDefault {
	var out []invalidDefault
	if schema.HasDefault() {
		if errs := ValidateInputValue(schema, schema.DefaultValue(), path); len(errs) > 0 {
			out = append(out, invalidDefault{Path: path, Problem: "is invalid: " + strings.Join(errs, "; ")})
		}
	}
	for _, name := range sortedKeys(schema.Properties) {
		out = append(out, invalidInputDefaults(schema.Properties[name], path+"."+name)...)
	}
	return out
}

func sortedKeys(m map[string]*InputSchema) []string {
	keys := slices.Sorted(maps.Keys(m))
	return keys
}
