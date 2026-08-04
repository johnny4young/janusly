// The tool registry: typed definitions with input validation, output
// validation and the public catalog projection the AI Studio reads
// (name, description, required, optional, inputExample, inputFields,
// writeSide). Ported from the source contract and its json
// tool family, including the prototype-pollution guards those tools carry.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Field describes one input field for the catalog's bounded form projection.
type Field struct {
	Name     string `json:"name"`
	Type     string `json:"kind"`
	Required bool   `json:"required"`
}

// Definition is one registered tool.
type Definition struct {
	Name         string
	Description  string
	Required     []string
	Optional     []string
	Fields       []Field
	InputExample map[string]any
	// WriteSide marks the static write-capability bit; input-sensitive tools
	// refine the exact effect at runtime.
	WriteSide bool
	Execute   func(ctx context.Context, input map[string]any) (map[string]any, error)
}

// Registry holds the tool set for one process.
type Registry struct {
	byName map[string]Definition
}

// NewRegistry builds the runtime's tool set.
func NewRegistry() *Registry {
	registry := &Registry{byName: map[string]Definition{}}
	for _, definition := range jsonTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range csvTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range vectorTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range integrationTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range emailTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range pdfTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range timeWindowTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range pagerDutyTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range dbTools() {
		registry.byName[definition.Name] = definition
	}
	registry.byName["text.uppercase"] = Definition{
		Name:         "text.uppercase",
		Description:  "Uppercase a text value.",
		Required:     []string{"value"},
		Fields:       []Field{{Name: "value", Type: "string", Required: true}},
		InputExample: map[string]any{"value": "hello"},
		Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
			value, _ := input["value"].(string)
			return map[string]any{"value": strings.ToUpper(value)}, nil
		},
	}
	return registry
}

// Catalog is the public listTools() projection, name-sorted for stability.
func (r *Registry) Catalog() []map[string]any {
	names := slices.Sorted(maps.Keys(r.byName))
	out := make([]map[string]any, 0, len(names))
	for _, name := range names {
		definition := r.byName[name]
		entry := map[string]any{
			"name": definition.Name, "description": definition.Description,
			"required": definition.Required, "inputFields": definition.Fields,
			"writeSide": definition.WriteSide,
		}
		if len(definition.Optional) > 0 {
			entry["optional"] = definition.Optional
		}
		if definition.InputExample != nil {
			entry["inputExample"] = definition.InputExample
		}
		out = append(out, entry)
	}
	return out
}

// ErrUnknownTool reports a name outside the registry.
type ErrUnknownTool struct{ Name string }

func (e *ErrUnknownTool) Error() string { return "Unknown tool: " + e.Name }

// Execute validates the input's required fields, runs the tool, and returns
// its output. Validation failures carry the contract's message shape.
func (r *Registry) Execute(ctx context.Context, name string, input map[string]any) (map[string]any, error) {
	definition, ok := r.byName[name]
	if !ok {
		return nil, &ErrUnknownTool{Name: name}
	}
	var missing []string
	for _, field := range definition.Required {
		if _, present := input[field]; !present {
			missing = append(missing, field+": Required")
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("Invalid tool input for %s: %s", name, strings.Join(missing, ", ")) //nolint:staticcheck // contract message is the wire contract
	}
	return definition.Execute(ctx, input)
}

// prototypeKeys are the JS prototype-pollution vectors the contract tools
// refuse; in Go they are ordinary map keys, but refusing them keeps a
// runtime-produced payload safe to feed back into the Janusly API.
var prototypeKeys = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}

func jsonTools() []Definition {
	return []Definition{
		{
			Name:         "json.parse",
			Description:  "Parse a JSON string into its native object, array, or primitive value.",
			Required:     []string{"value"},
			Fields:       []Field{{Name: "value", Type: "string", Required: true}},
			InputExample: map[string]any{"value": `{"customer":{"id":42}}`},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				text, ok := input["value"].(string)
				if !ok {
					return nil, fmt.Errorf("json.parse received invalid JSON")
				}
				var parsed any
				if err := json.Unmarshal([]byte(text), &parsed); err != nil {
					return nil, fmt.Errorf("json.parse received invalid JSON")
				}
				return map[string]any{"value": parsed}, nil
			},
		},
		{
			Name:         "json.pick",
			Description:  "Pick a value from workflow context using a dot path.",
			Required:     []string{"path"},
			Optional:     []string{"source"},
			Fields:       []Field{{Name: "path", Type: "string", Required: true}, {Name: "source", Type: "object"}},
			InputExample: map[string]any{"path": "fetch.output.statusCode"},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				path, _ := input["path"].(string)
				return map[string]any{"value": pickByPath(input["source"], path)}, nil
			},
		},
		{
			Name:        "json.set",
			Description: "Return a copy of `source` with `value` set at the dotted `path`.",
			Required:    []string{"path", "value"},
			Optional:    []string{"source"},
			Fields: []Field{
				{Name: "path", Type: "string", Required: true},
				{Name: "value", Type: "unknown", Required: true},
				{Name: "source", Type: "object"},
			},
			InputExample: map[string]any{
				"source": map[string]any{"user": map[string]any{"id": 1}},
				"path":   "user.name", "value": "Ada",
			},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				path, _ := input["path"].(string)
				value, err := setByPath(input["source"], path, input["value"])
				if err != nil {
					return nil, err
				}
				return map[string]any{"value": value}, nil
			},
		},
		{
			Name:        "json.merge",
			Description: "Deep-merge two objects; `b` wins on key conflicts. Arrays are replaced wholesale.",
			Required:    []string{"a", "b"},
			Fields: []Field{
				{Name: "a", Type: "object", Required: true},
				{Name: "b", Type: "object", Required: true},
			},
			InputExample: map[string]any{
				"a": map[string]any{"user": map[string]any{"id": 1}},
				"b": map[string]any{"user": map[string]any{"name": "Ada"}},
			},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				left, _ := input["a"].(map[string]any)
				right, _ := input["b"].(map[string]any)
				return map[string]any{"value": deepMerge(left, right)}, nil
			},
		},
	}
}

func pickByPath(source any, path string) any {
	current := source
	for segment := range strings.SplitSeq(path, ".") {
		if segment == "" {
			continue
		}
		switch container := current.(type) {
		case map[string]any:
			value, ok := container[segment]
			if !ok {
				return nil
			}
			current = value
		case []any:
			index := -1
			if _, err := fmt.Sscanf(segment, "%d", &index); err != nil || index < 0 || index >= len(container) {
				return nil
			}
			current = container[index]
		default:
			return nil
		}
	}
	return current
}

func setByPath(source any, path string, value any) (any, error) {
	segments := []string{}
	for segment := range strings.SplitSeq(path, ".") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return source, nil
	}
	for _, segment := range segments {
		if prototypeKeys[segment] {
			return nil, fmt.Errorf("json.set refuses prototype-targeting path segments: %s", path)
		}
	}
	root := map[string]any{}
	if existing, ok := source.(map[string]any); ok {
		maps.Copy(root, existing)
	}
	cursor := root
	for _, segment := range segments[:len(segments)-1] {
		next := map[string]any{}
		if existing, ok := cursor[segment].(map[string]any); ok {
			maps.Copy(next, existing)
		}
		cursor[segment] = next
		cursor = next
	}
	cursor[segments[len(segments)-1]] = value
	return root, nil
}

func deepMerge(left, right map[string]any) map[string]any {
	out := map[string]any{}
	maps.Copy(out, left)
	for key, value := range right {
		if prototypeKeys[key] {
			continue
		}
		leftValue, leftIsMap := out[key].(map[string]any)
		rightValue, rightIsMap := value.(map[string]any)
		if leftIsMap && rightIsMap {
			out[key] = deepMerge(leftValue, rightValue)
			continue
		}
		out[key] = value
	}
	return out
}

// Register adds one tool definition; later registrations override earlier
// ones by name. The executors package uses this to contribute tools that
// need machinery living there (the SSRF-gated streaming fetch).
func (r *Registry) Register(definition Definition) {
	r.byName[definition.Name] = definition
}

// IsWriteSide reports the static write-capability bit for a registered tool;
// unknown names are read-side (the contract's registry lookup does the same).
func (r *Registry) IsWriteSide(name string) bool {
	definition, ok := r.byName[name]
	return ok && definition.WriteSide
}

// vectorTools are catalog entries for the org-scoped memory tools. Their
// execution REQUIRES engine context (org, run, consent), so the tool-node
// executor intercepts them before generic dispatch; calling them through
// the bare registry (no engine) answers with the engine-context error.
func vectorTools() []Definition {
	engineOnly := func(context.Context, map[string]any) (map[string]any, error) {
		return nil, fmt.Errorf("vector tools require engine context")
	}
	return []Definition{
		{
			Name:        "vector.search",
			Description: "Search the org's vector memory (workflow_vector kind) by semantic similarity.",
			Required:    []string{"query"},
			Fields: []Field{
				{Name: "query", Type: "string"},
			},
			InputExample: map[string]any{"query": "prior fixes for the billing webhook"},
			Execute:      engineOnly,
		},
		{
			Name:        "vector.upsert",
			Description: "Store one entry in the org's vector memory (workflow_vector kind). Consent-gated.",
			Required:    []string{"content"},
			Fields: []Field{
				{Name: "content", Type: "string"},
				{Name: "metadata", Type: "object"},
			},
			InputExample: map[string]any{"content": "retries with backoff fixed the timeout"},
			WriteSide:    true,
			Execute:      engineOnly,
		},
	}
}

// PlannerTools is the LLM planner's availableTools projection: the
// catalog entries (name, description, required/optional, fields), with
// every write-side tool HIDDEN when dryRun — a validation run must not
// even show the model a write.
func (r *Registry) PlannerTools(dryRun bool) []map[string]any {
	names := slices.Sorted(maps.Keys(r.byName))
	out := make([]map[string]any, 0, len(names))
	for _, name := range names {
		definition := r.byName[name]
		if dryRun && definition.WriteSide {
			continue
		}
		entry := map[string]any{
			"name": definition.Name, "description": definition.Description,
			"required": definition.Required, "inputFields": definition.Fields,
			"writeSide": definition.WriteSide,
			// jsonSchema is the PLANNER-ONLY projection: a JSON-Schema
			// object derived from the same field table. It never leaves
			// through the public /tools catalog — prompt plumbing only.
			"jsonSchema": plannerJSONSchema(definition),
		}
		if len(definition.Optional) > 0 {
			entry["optional"] = definition.Optional
		}
		out = append(out, entry)
	}
	return out
}

// plannerJSONSchema derives the private planner schema from the field
// table (the contract keeps this projection out of listTools()).
func plannerJSONSchema(definition Definition) map[string]any {
	properties := map[string]any{}
	for _, field := range definition.Fields {
		fieldType := field.Type
		if fieldType == "" {
			fieldType = "string"
		}
		properties[field.Name] = map[string]any{"type": fieldType}
	}
	schema := map[string]any{"type": "object", "properties": properties}
	if len(definition.Required) > 0 {
		schema["required"] = definition.Required
	}
	return schema
}
