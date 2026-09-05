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
	"math"
	"reflect"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/grammar"
)

// Field describes one input field for the catalog's bounded form projection.
type Field struct {
	Name     string `json:"name"`
	Type     string `json:"kind"`
	Required bool   `json:"required"`
	// AcceptedTypes retains an executable union when the stable public form
	// projection must use the generic `json` editor. It never appears on the
	// wire; the planner schema and registry validator consume it directly.
	AcceptedTypes []string `json:"-"`
}

// InputValidationOptions distinguish an incomplete authoring draft from a
// persisted workflow and both of those from a rendered runtime invocation.
type InputValidationOptions struct {
	RequireAll          bool
	AllowWholeTemplates bool
}

// Definition is one registered tool.
type Definition struct {
	Name         string
	Description  string
	Required     []string
	Optional     []string
	Fields       []Field
	InputExample map[string]any
	// Validate applies definition-specific semantics after the generic field
	// grammar succeeds. allowWholeTemplates is true only for persisted
	// workflows and authoring drafts; runtime callers pass false after
	// rendering so an unresolved expression can never reach Execute.
	//
	// The callback returns a detail message rather than the full public error;
	// Registry owns the stable "Invalid tool input for <name>" envelope.
	Validate func(input map[string]any, options InputValidationOptions) error
	// WriteSide marks the static write-capability bit; input-sensitive tools
	// refine the exact effect at runtime.
	WriteSide bool
	// Local must be opted into by deterministic in-process helpers. The zero
	// value is deliberately external so a newly registered tool cannot bypass
	// readiness retry requirements by forgetting capability metadata.
	Local   bool
	Execute func(ctx context.Context, input map[string]any) (map[string]any, error)
}

// CatalogEntry is the executable registry's safe, typed projection for
// authoring surfaces. It deliberately omits Execute so the same value can be
// shared by the API, AI binding checks and MCP without accidentally exposing
// runtime callbacks or credential material.
type CatalogEntry struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Required     []string       `json:"required"`
	Optional     []string       `json:"optional,omitempty"`
	InputFields  []Field        `json:"inputFields"`
	InputExample map[string]any `json:"inputExample,omitempty"`
	WriteSide    bool           `json:"writeSide"`
}

// Registry holds the tool set for one process.
type Registry struct {
	byName map[string]Definition
}

// NewRegistry builds the runtime's tool set.
func NewRegistry() *Registry {
	registry := &Registry{byName: map[string]Definition{}}
	for _, definition := range jsonTools() {
		definition.Local = true
		registry.byName[definition.Name] = definition
	}
	for _, definition := range csvTools() {
		definition.Local = true
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
	for _, definition := range sheetTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range pdfTools() {
		registry.byName[definition.Name] = definition
	}
	for _, definition := range timeWindowTools() {
		definition.Local = true
		registry.byName[definition.Name] = definition
	}
	for _, definition := range pagerDutyTools() {
		definition.Local = !IsIntegrationTool(definition.Name)
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
		Validate: func(input map[string]any, options InputValidationOptions) error {
			raw, present := input["value"]
			if !present || isDeferredWholeTemplate(raw, options) {
				return nil
			}
			value := raw.(string)
			if len(value) > jsonToolMaxBytes || len(strings.ToUpper(value)) > jsonToolMaxBytes {
				return fmt.Errorf("uppercase input or output exceeds %d bytes", jsonToolMaxBytes)
			}
			return nil
		},
		Local: true,
		Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
			value, _ := input["value"].(string)
			return map[string]any{"value": strings.ToUpper(value)}, nil
		},
	}
	return registry
}

// Catalog is the public listTools() projection, name-sorted for stability.
func (r *Registry) Catalog() []map[string]any {
	entries := r.CatalogEntries()
	out := make([]map[string]any, 0, len(entries))
	for _, catalogEntry := range entries {
		projected := map[string]any{
			"name": catalogEntry.Name, "description": catalogEntry.Description,
			"required": catalogEntry.Required, "inputFields": catalogEntry.InputFields,
			"writeSide": catalogEntry.WriteSide,
		}
		if len(catalogEntry.Optional) > 0 {
			projected["optional"] = catalogEntry.Optional
		}
		if catalogEntry.InputExample != nil {
			projected["inputExample"] = catalogEntry.InputExample
		}
		out = append(out, projected)
	}
	return out
}

// CatalogEntries returns a name-sorted, copy-owned catalog. Slice and map
// fields are cloned so callers cannot mutate the process-wide runtime
// definitions while preparing an authoring response.
func (r *Registry) CatalogEntries() []CatalogEntry {
	names := slices.Sorted(maps.Keys(r.byName))
	out := make([]CatalogEntry, 0, len(names))
	for _, name := range names {
		definition := r.byName[name]
		required := slices.Clone(definition.Required)
		if required == nil {
			required = []string{}
		}
		inputFields := slices.Clone(definition.Fields)
		for index := range inputFields {
			inputFields[index].AcceptedTypes = slices.Clone(inputFields[index].AcceptedTypes)
		}
		if inputFields == nil {
			inputFields = []Field{}
		}
		entry := CatalogEntry{
			Name: definition.Name, Description: definition.Description,
			Required: required, Optional: slices.Clone(definition.Optional),
			InputFields: inputFields, WriteSide: definition.WriteSide,
		}
		if definition.InputExample != nil {
			entry.InputExample = maps.Clone(definition.InputExample)
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
	if err := r.ValidateResolvedInput(name, input); err != nil {
		return nil, err
	}
	definition := r.byName[name]
	return definition.Execute(ctx, input)
}

// ValidateInput applies the registry-owned pre-execution contract without
// invoking the tool. Workflow save/readiness paths use it so missing required
// fields and statically invalid values fail before a run can reach a side
// effect. Whole dynamic template references are accepted here and checked
// again after rendering, when their native type is known.
func (r *Registry) ValidateInput(name string, input map[string]any) error {
	return r.validateInput(name, input, true, true)
}

// ValidatePartialInput validates every present field while permitting required
// fields to be absent. AI proposals use this posture so an unresolved binding
// can remain visibly incomplete without allowing an already supplied value of
// the wrong type into the draft.
func (r *Registry) ValidatePartialInput(name string, input map[string]any) error {
	return r.validateInput(name, input, false, true)
}

// ValidateResolvedInput applies the strict runtime posture. Unlike
// ValidateInput, it rejects every still-unresolved whole template reference;
// callers must render first and then cross this boundary immediately before
// any local or external effect.
func (r *Registry) ValidateResolvedInput(name string, input map[string]any) error {
	return r.validateInput(name, input, true, false)
}

func (r *Registry) validateInput(name string, input map[string]any, requireAll, allowWholeTemplates bool) error {
	definition, ok := r.byName[name]
	if !ok {
		return &ErrUnknownTool{Name: name}
	}
	var issues []string
	knownFields := make(map[string]bool, len(definition.Fields))
	for _, field := range definition.Fields {
		knownFields[field.Name] = true
	}
	unknownFields := make([]string, 0)
	for field := range input {
		if !knownFields[field] {
			unknownFields = append(unknownFields, field)
		}
	}
	slices.Sort(unknownFields)
	for _, field := range unknownFields {
		issues = append(issues, field+": Unsupported field")
	}
	if requireAll {
		for _, field := range definition.Required {
			if _, present := input[field]; !present {
				issues = append(issues, field+": Required")
			}
		}
	}
	for _, field := range definition.Fields {
		value, present := input[field.Name]
		if !present {
			continue
		}
		if !validFieldValue(field, value, allowWholeTemplates) {
			issues = append(issues, field.Name+": Expected "+expectedFieldKind(field))
		}
	}
	// Avoid noisy duplicate diagnostics when the generic shape is already
	// invalid. Semantic validation still runs for partial drafts with omitted
	// required fields, allowing it to reject supplied-but-invalid options.
	if len(issues) == 0 && definition.Validate != nil {
		if err := definition.Validate(input, InputValidationOptions{
			RequireAll: requireAll, AllowWholeTemplates: allowWholeTemplates,
		}); err != nil {
			issues = append(issues, err.Error())
		}
	}
	if len(issues) > 0 {
		return fmt.Errorf("Invalid tool input for %s: %s", name, strings.Join(issues, ", ")) //nolint:staticcheck // contract message is the wire contract
	}
	return nil
}

func validFieldValue(field Field, value any, allowWholeTemplates bool) bool {
	kinds := field.AcceptedTypes
	if len(kinds) == 0 {
		kinds = []string{field.Type}
	}
	// A whole ordinary reference may resolve to any native JSON type. Secret
	// and environment references always resolve to strings, so they cannot be
	// used to smuggle a textual number/object past the save-time contract.
	if allowWholeTemplates {
		text, ok := value.(string)
		if !ok {
			text = ""
		}
		if expression, whole := grammar.WholeTemplateReference(text); whole {
			stringOnly := strings.HasPrefix(expression, "secret.") || strings.HasPrefix(expression, "env.")
			if !stringOnly {
				return true
			}
			for _, kind := range kinds {
				if kind == "" || kind == "string" || kind == "json" || kind == "unknown" {
					return true
				}
			}
			return false
		}
	}
	for _, kind := range kinds {
		if validConcreteFieldKind(kind, value) {
			return true
		}
	}
	return false
}

func validConcreteFieldKind(kind string, value any) bool {
	switch kind {
	case "", "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		object, ok := value.(map[string]any)
		if !ok || object == nil {
			return false
		}
		_, err := json.Marshal(object)
		return err == nil
	case "array":
		reflected := reflect.ValueOf(value)
		if !reflected.IsValid() || (reflected.Kind() != reflect.Slice && reflected.Kind() != reflect.Array) {
			return false
		}
		if reflected.Kind() == reflect.Slice && reflected.IsNil() {
			return false
		}
		// encoding/json represents byte slices as base64 strings, not arrays.
		if reflected.Type().Elem().Kind() == reflect.Uint8 {
			return false
		}
		_, err := json.Marshal(value)
		return err == nil
	case "number":
		return validJSONNumber(value)
	case "json", "unknown":
		_, err := json.Marshal(value)
		return err == nil
	default:
		return false
	}
}

func expectedFieldKind(field Field) string {
	kinds := field.AcceptedTypes
	if len(kinds) == 0 {
		kind := field.Type
		if kind == "" {
			kind = "string"
		}
		return kind
	}
	return strings.Join(kinds, " or ")
}

func validJSONNumber(value any) bool {
	switch number := value.(type) {
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	case float32:
		return !math.IsNaN(float64(number)) && !math.IsInf(float64(number), 0)
	case float64:
		return !math.IsNaN(number) && !math.IsInf(number, 0)
	case json.Number:
		parsed, err := number.Float64()
		return err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	default:
		return false
	}
}

// boundedWholeNumber normalizes the numeric representations that may arrive
// from decoded JSON or trusted internal callers. It is intentionally package
// local so semantic validators across the built-in tool family share one
// integer grammar without coupling non-HTTP tools to httpcontract.
func boundedWholeNumber(value any, minimum, maximum int64) (int64, bool) {
	within := func(number int64) (int64, bool) {
		return number, number >= minimum && number <= maximum
	}
	switch number := value.(type) {
	case int:
		return within(int64(number))
	case int8:
		return within(int64(number))
	case int16:
		return within(int64(number))
	case int32:
		return within(int64(number))
	case int64:
		return within(number)
	case uint:
		if maximum < 0 || uint64(number) > uint64(maximum) {
			return 0, false
		}
		return within(int64(number))
	case uint8:
		return within(int64(number))
	case uint16:
		return within(int64(number))
	case uint32:
		return within(int64(number))
	case uint64:
		if maximum < 0 || number > uint64(maximum) {
			return 0, false
		}
		return within(int64(number))
	case float32:
		value := float64(number)
		if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value ||
			value < float64(minimum) || value > float64(maximum) {
			return 0, false
		}
		return int64(value), true
	case float64:
		if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number ||
			number < float64(minimum) || number > float64(maximum) {
			return 0, false
		}
		return int64(number), true
	case json.Number:
		parsed, err := number.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || math.Trunc(parsed) != parsed ||
			parsed < float64(minimum) || parsed > float64(maximum) {
			return 0, false
		}
		return int64(parsed), true
	default:
		return 0, false
	}
}

func isDeferredWholeTemplate(value any, options InputValidationOptions) bool {
	if !options.AllowWholeTemplates {
		return false
	}
	text, ok := value.(string)
	if !ok {
		return false
	}
	_, whole := grammar.WholeTemplateReference(text)
	return whole
}

func arrayItems(value any) ([]any, bool) {
	reflected := reflect.ValueOf(value)
	if !reflected.IsValid() || (reflected.Kind() != reflect.Slice && reflected.Kind() != reflect.Array) {
		return nil, false
	}
	if reflected.Kind() == reflect.Slice && reflected.IsNil() || reflected.Type().Elem().Kind() == reflect.Uint8 {
		return nil, false
	}
	items := make([]any, reflected.Len())
	for index := range reflected.Len() {
		items[index] = reflected.Index(index).Interface()
	}
	return items, true
}

// Register adds one tool definition; later registrations override earlier
// ones by name. The executors package uses this to contribute tools that
// need machinery living there (the SSRF-gated streaming fetch).
func (r *Registry) Register(definition Definition) {
	r.byName[definition.Name] = definition
}

// Has reports whether name resolves to an executable definition. Policy
// callers use this before interpreting the registry's conservative metadata:
// unknown tools are external for readiness, but they are not executable and
// therefore cannot be candidates for automated repair.
func (r *Registry) Has(name string) bool {
	_, ok := r.byName[name]
	return ok
}

// IsWriteSide reports the static write-capability bit for a registered tool;
// unknown names are read-side (the contract's registry lookup does the same).
func (r *Registry) IsWriteSide(name string) bool {
	definition, ok := r.byName[name]
	return ok && definition.WriteSide
}

// IsExternal reports whether a tool crosses a runtime boundary. Unknown tools
// are deliberately external so registry drift cannot weaken readiness.
func (r *Registry) IsExternal(name string) bool {
	definition, ok := r.byName[name]
	return !ok || !definition.Local
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
		properties[field.Name] = plannerFieldJSONSchema(field)
	}
	schema := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(definition.Required) > 0 {
		schema["required"] = definition.Required
	}
	return schema
}

func plannerFieldJSONSchema(field Field) map[string]any {
	kinds := field.AcceptedTypes
	if len(kinds) == 0 {
		kinds = []string{field.Type}
	}
	variants := make([]any, 0, len(kinds))
	for _, kind := range kinds {
		if kind == "" {
			kind = "string"
		}
		// json/unknown describe an unconstrained JSON value. Emitting those
		// literals as a JSON-Schema `type` would produce an invalid schema.
		if kind == "json" || kind == "unknown" {
			return map[string]any{}
		}
		variants = append(variants, map[string]any{"type": kind})
	}
	if len(variants) == 1 {
		return variants[0].(map[string]any)
	}
	return map[string]any{"anyOf": variants}
}
