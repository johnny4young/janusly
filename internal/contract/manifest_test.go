package contract

import (
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The manifest is pure data the generator trusts — every entry
// carries a method, a versioned path, and a response shape; no
// duplicates hide behind reorderings.
func TestManifestInvariants(t *testing.T) {
	if len(Routes) == 0 {
		t.Fatal("the v1 manifest must not be empty")
	}
	seen := map[string]bool{}
	for _, route := range Routes {
		if route.Method == "" || route.Path == "" || route.Summary == "" {
			t.Fatalf("manifest entry incomplete: %+v", route)
		}
		if route.Path[0] != '/' {
			t.Fatalf("path must be absolute: %q", route.Path)
		}
		key := route.Method + " " + route.Path
		if seen[key] {
			t.Fatalf("duplicate manifest entry %s", key)
		}
		seen[key] = true
		if route.Response == nil {
			t.Fatalf("%s has no response shape", key)
		}
	}
}

func TestWorkflowSaveManifestPreservesAuthorityBoundary(t *testing.T) {
	allowsAdditional, declared := workflowSaveDoc["additionalProperties"].(bool)
	if !declared || allowsAdditional {
		t.Fatal("workflow save request must reject unknown top-level fields")
	}
	properties, _ := workflowSaveDoc["properties"].(map[string]any)
	if properties == nil || properties["upstreamHealthSources"] == nil {
		t.Fatal("workflow save request must declare its upstream-health carrier")
	}
	if properties["slo"] != nil {
		t.Fatal("editor-level workflow save must not expose the admin-owned SLO mutation")
	}
}

func TestGovernedMutationManifestsRejectUnknownProperties(t *testing.T) {
	t.Parallel()
	for name, schema := range map[string]Schema{
		"diagnose":      recoveryRevisionRequest,
		"validate":      recoveryCandidateBindingRequest,
		"approve/apply": recoveryApprovalBindingRequest,
	} {
		if allows, declared := schema["additionalProperties"].(bool); !declared || allows {
			t.Fatalf("%s request must advertise the runtime's strict decoder", name)
		}
	}
	if allows, declared := workflowIntentBriefInput["additionalProperties"].(bool); !declared || allows {
		t.Fatal("nested Intent Brief input must advertise the runtime's strict decoder")
	}
	for _, route := range Routes {
		switch route.Path {
		case "/v1/recovery/cases/{caseId}/candidates",
			"/v1/ai/workflow-briefs/compile", "/v1/ai/workflow-proposals":
			if allows, declared := route.Request["additionalProperties"].(bool); !declared || allows {
				t.Fatalf("%s must reject unknown top-level request fields", route.Path)
			}
		}
	}
}

func findRoute(t *testing.T, method, path string) Route {
	t.Helper()
	for _, route := range Routes {
		if route.Method == method && route.Path == path {
			return route
		}
	}
	t.Fatalf("manifest has no %s %s", method, path)
	return Route{}
}

func requiredOf(schema map[string]any) map[string]bool {
	out := map[string]bool{}
	list, _ := schema["required"].([]string)
	for _, key := range list {
		out[key] = true
	}
	return out
}

// The generated TypeScript types are only as good as these shapes. Both
// endpoints used to be described as something the handlers never emitted
// (a bare array, four fields of eight), which made the typed client unusable
// for them. The manifest now says what Go serves.
func TestDlqClustersAndRecoveryMetricsManifestsMatchTheRuntimeShape(t *testing.T) {
	clusters := findRoute(t, "GET", "/v1/dlq/clusters").Response
	if clusters["type"] != "object" {
		t.Fatalf("/v1/dlq/clusters must be an object envelope, got %v", clusters["type"])
	}
	required := requiredOf(clusters)
	for _, key := range []string{"clusters", "totalSamples", "windowDays"} {
		if !required[key] {
			t.Fatalf("/v1/dlq/clusters must require %q", key)
		}
	}
	properties, _ := clusters["properties"].(map[string]any)
	if items, _ := properties["clusters"].(map[string]any); items["type"] != "array" {
		t.Fatalf("clusters must be an array, got %v", items)
	}

	metrics := findRoute(t, "GET", "/v1/recovery/metrics").Response
	properties, _ = metrics["properties"].(map[string]any)
	for _, key := range []string{
		"successRate", "verifiedRecovery", "mttr", "p95Latency", "approvalsPending",
		"replayRate", "costThisWindow", "clustersResolved", "slaAttainment",
		"timeToFirstAction", "recurrenceRate", "valueEstimate",
	} {
		if _, ok := properties[key]; !ok {
			t.Fatalf("/v1/recovery/metrics must describe %q", key)
		}
	}
	if _, stale := properties["data"]; stale {
		t.Fatal("/v1/recovery/metrics no longer carries a data envelope")
	}
}

const workflowDocumentReason = "the domain workflow parser strips unknown keys, and stored versions are served as persisted bytes"

// openSchemaAllowlist names every schema allowed to leave keys or values
// undescribed. Shared fragments are keyed by name so one entry covers every
// route that embeds them; route-local entries use "METHOD PATH request|response#...".
var openSchemaAllowlist = map[string]string{
	"workflowDoc#":                workflowDocumentReason,
	"workflowNodeDoc#":            workflowDocumentReason,
	"workflowEdgeDoc#":            workflowDocumentReason,
	"workflowMetadataDoc#":        workflowDocumentReason,
	"workflowUIDoc#":              workflowDocumentReason,
	"workflowPositionDoc#":        workflowDocumentReason,
	"workflowNodeConfig#":         "node configuration is validated by each node type's executor, not the transport",
	"workflowParsedJSON#":         "recursive input schemas and versioned recovery contracts are validated by the domain parser",
	"workflowComparisonSnapshot#": "callers send their whole canvas document; only nodes and edges are read for the diff",
	"relayPayload#":               "trigger payloads are the upstream system's own event body",
	"humanInput#":                 "form input is validated against the waiting node's declared schema at resume time",
	"runInput#":                   "start input is validated against the workflow's declared input schema",
	"toolInputExample#":           "an example of the tool's own input object, which the tool validates at execution",
	"runJSON#":                    "run input, output, node state, error and event payloads are extension JSON owned by node executors",
	"dlqSnapshot#":                "dead-letter snapshots keep the failed run's workflow, node and error JSON verbatim",
	"storedColumnJSON#":           "persisted jsonb columns (SLO, upstream sources, recovery comments) are echoed verbatim",
	"recoveryEvidenceJSON#":       "recovery case details, artifact payloads and transition evidence are versioned engine evidence",
	"memoryMetadata#":             "memory metadata is redacted context recorded with each summary",
	"replacementOutput#":          "replacement output is validated against the workflow's business outcome contract",
}

func namedFragments() map[uintptr]string {
	fragments := map[string]map[string]any{
		"workflowDoc": workflowDoc, "workflowNodeDoc": workflowNodeDoc, "workflowEdgeDoc": workflowEdgeDoc,
		"workflowMetadataDoc": workflowMetadataDoc, "workflowUIDoc": workflowUIDoc,
		"workflowPositionDoc": workflowPositionDoc, "workflowNodeConfig": workflowNodeConfig,
		"workflowParsedJSON": workflowParsedJSON, "workflowComparisonSnapshot": workflowComparisonSnapshot,
		"relayPayload": relayPayload, "humanInput": humanInput, "runInput": runInput,
		"toolInputExample": toolInputExample, "runJSON": runJSON, "dlqSnapshot": dlqSnapshot,
		"storedColumnJSON": storedColumnJSON, "recoveryEvidenceJSON": recoveryEvidenceJSON,
		"memoryMetadata": memoryMetadata, "replacementOutput": replacementOutput,
	}
	byIdentity := make(map[uintptr]string, len(fragments))
	for name, schema := range fragments {
		byIdentity[reflect.ValueOf(schema).Pointer()] = name
	}
	return byIdentity
}

func asSchemaMap(value any) (map[string]any, bool) {
	switch typed := value.(type) {
	case Schema:
		return typed, true
	case map[string]any:
		return typed, true
	}
	return nil, false
}

// A node that names no type or combinator accepts any JSON value.
func isUntyped(schema map[string]any) bool {
	for _, keyword := range []string{"type", "const", "enum", "oneOf", "anyOf", "allOf", "$ref"} {
		if _, present := schema[keyword]; present {
			return false
		}
	}
	return true
}

func isObjectTyped(schema map[string]any) bool {
	switch kind := schema["type"].(type) {
	case string:
		return kind == "object"
	case []any:
		return slices.Contains(kind, any("object"))
	}
	return false
}

// A typed map (no declared properties, constrained values) is closed: its
// keys are data. Anything else must reject unknown keys explicitly.
func isClosedObject(schema map[string]any) bool {
	if allows, declared := schema["additionalProperties"].(bool); declared {
		return !allows
	}
	properties, _ := schema["properties"].(map[string]any)
	values, typedMap := asSchemaMap(schema["additionalProperties"])
	return typedMap && len(properties) == 0 && !isUntyped(values)
}

func isOpenSchema(schema map[string]any) bool {
	return isUntyped(schema) || (isObjectTyped(schema) && !isClosedObject(schema))
}

func walkSchema(value any, path string, fragments map[uintptr]string, visit func(string, map[string]any)) {
	schema, ok := asSchemaMap(value)
	if !ok {
		return
	}
	if name, named := fragments[reflect.ValueOf(schema).Pointer()]; named {
		path = name + "#"
	}
	visit(path, schema)
	if properties, ok := schema["properties"].(map[string]any); ok {
		for _, key := range slices.Sorted(maps.Keys(properties)) {
			walkSchema(properties[key], path+"/properties/"+key, fragments, visit)
		}
	}
	walkSchema(schema["items"], path+"/items", fragments, visit)
	walkSchema(schema["additionalProperties"], path+"/additionalProperties", fragments, visit)
	for _, keyword := range []string{"anyOf", "oneOf", "allOf"} {
		branches, _ := schema[keyword].([]any)
		for index, branch := range branches {
			walkSchema(branch, fmt.Sprintf("%s/%s/%d", path, keyword, index), fragments, visit)
		}
	}
}

// openSchemaPaths reports open schemas under root that the allowlist does not
// name, and records the allowlist entries it matched.
func openSchemaPaths(schema Schema, root string, fragments map[uintptr]string, used map[string]bool) []string {
	var open []string
	walkSchema(schema, root, fragments, func(path string, node map[string]any) {
		if !isOpenSchema(node) {
			return
		}
		if _, allowed := openSchemaAllowlist[path]; allowed {
			used[path] = true
			return
		}
		open = append(open, path)
	})
	return open
}

func TestEveryRouteSchemaIsClosed(t *testing.T) {
	fragments := namedFragments()
	used := map[string]bool{}
	var open []string
	for _, route := range Routes {
		for direction, schema := range map[string]Schema{"request": route.Request, "response": route.Response} {
			if schema != nil {
				open = append(open, openSchemaPaths(schema, route.Method+" "+route.Path+" "+direction+"#", fragments, used)...)
			}
		}
	}
	if len(open) > 0 {
		slices.Sort(open)
		open = slices.Compact(open)
		t.Errorf("%d open schema(s): close the object, type the value, or add an "+
			"openSchemaAllowlist entry with the reason it is legitimately open:\n   %s",
			len(open), strings.Join(open, "\n   "))
	}
	for path, reason := range openSchemaAllowlist {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("allowlist entry %s has no reason", path)
		}
		if !used[path] {
			t.Errorf("allowlist entry %s matches no open schema; delete it", path)
		}
	}
}

func TestClosedSchemaGateRejectsOpenShapes(t *testing.T) {
	fragments := namedFragments()
	closed := closedObj(map[string]any{"id": str()}, "id")
	for name, schema := range map[string]Schema{
		"properties without type":   {"properties": map[string]any{"id": str()}, "additionalProperties": false},
		"unnamed opaque value":      closedObj(map[string]any{"value": opaqueJSON()}, "value"),
		"explicit open object":      obj(map[string]any{"id": str()}, "id"),
		"open object in a union":    {"oneOf": []any{closed, obj(map[string]any{"id": str()})}},
		"open value in a typed map": {"type": "object", "additionalProperties": opaqueJSON()},
	} {
		if len(openSchemaPaths(schema, "probe#", fragments, map[string]bool{})) == 0 {
			t.Errorf("%s passed the closed-schema gate", name)
		}
	}
	for name, schema := range map[string]Schema{
		"closed object": closed,
		"typed map":     {"type": "object", "additionalProperties": str()},
		"nullable":      nullable(closed),
		"enum":          {"enum": []any{"a", "b"}},
	} {
		if open := openSchemaPaths(schema, "probe#", fragments, map[string]bool{}); len(open) > 0 {
			t.Errorf("%s was reported open: %v", name, open)
		}
	}
}

func collectRefs(value any, refs map[string]bool) {
	switch typed := value.(type) {
	case map[string]any:
		if ref, ok := typed["$ref"].(string); ok {
			refs[strings.TrimPrefix(ref, ComponentRef(""))] = true
		}
		for _, child := range typed {
			collectRefs(child, refs)
		}
	case []any:
		for _, child := range typed {
			collectRefs(child, refs)
		}
	}
}

// A registered component must be distinct and reachable from some route, or
// the rendered document carries a schema nothing uses.
func TestComponentsAreUniqueAndReachable(t *testing.T) {
	schemas, err := ComponentSchemas()
	if err != nil {
		t.Fatal(err)
	}
	refs := map[string]bool{}
	for _, route := range Routes {
		collectRefs(RenderSchema(route.Response), refs)
		if route.Request != nil {
			collectRefs(RenderSchema(route.Request), refs)
		}
	}
	collectRefs(schemas, refs)
	for _, component := range Components {
		if !refs[component.Name] {
			t.Errorf("component %s is not referenced by any route", component.Name)
		}
	}
	for name := range refs {
		if schemas[name] == nil {
			t.Errorf("$ref to unregistered component %s", name)
		}
	}
	if rendered, _ := RenderSchema(workflowDoc).(map[string]any); rendered["$ref"] != ComponentRef("WorkflowDoc") {
		t.Fatalf("a registered fragment must render as a $ref, got %v", rendered)
	}
}
