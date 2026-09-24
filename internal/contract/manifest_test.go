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

const stripParsedReason = "the domain workflow parser strips unknown keys instead of rejecting them"

// openSchemaAllowlist names every object schema allowed to accept unknown
// keys. Shared fragments are keyed by name so one entry covers every route
// that embeds them; route-local entries use "METHOD PATH request|response#...".
var openSchemaAllowlist = map[string]string{
	"workflowDoc#":                stripParsedReason,
	"workflowNodeDoc#":            stripParsedReason,
	"workflowEdgeDoc#":            stripParsedReason,
	"workflowMetadataDoc#":        stripParsedReason,
	"workflowUIDoc#":              stripParsedReason,
	"workflowPositionDoc#":        stripParsedReason,
	"workflowNodeConfig#":         "node configuration is validated by each node type's executor, not the transport",
	"workflowComparisonSnapshot#": "callers send their whole canvas document; only nodes and edges are read for the diff",
	"relayPayload#":               "trigger payloads are the upstream system's own event body",
	"humanInput#":                 "form input is validated against the waiting node's declared schema at resume time",
	"toolInputExample#":           "an example of the tool's own input object, which the tool validates at execution",
}

func namedFragments() map[uintptr]string {
	fragments := map[string]map[string]any{
		"workflowDoc": workflowDoc, "workflowNodeDoc": workflowNodeDoc, "workflowEdgeDoc": workflowEdgeDoc,
		"workflowMetadataDoc": workflowMetadataDoc, "workflowUIDoc": workflowUIDoc,
		"workflowPositionDoc": workflowPositionDoc, "workflowNodeConfig": workflowNodeConfig,
		"workflowComparisonSnapshot": workflowComparisonSnapshot,
		"relayPayload":               relayPayload, "humanInput": humanInput, "toolInputExample": toolInputExample,
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
	return typedMap && len(properties) == 0 && len(values) > 0
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

func TestEveryRouteSchemaIsClosed(t *testing.T) {
	fragments := namedFragments()
	used := map[string]bool{}
	var open []string
	for _, route := range Routes {
		for direction, schema := range map[string]Schema{"request": route.Request, "response": route.Response} {
			if schema == nil {
				continue
			}
			root := route.Method + " " + route.Path + " " + direction + "#"
			walkSchema(schema, root, fragments, func(path string, node map[string]any) {
				if !isObjectTyped(node) || isClosedObject(node) {
					return
				}
				if _, allowed := openSchemaAllowlist[path]; allowed {
					used[path] = true
					return
				}
				open = append(open, path)
			})
		}
	}
	if len(open) > 0 {
		slices.Sort(open)
		open = slices.Compact(open)
		t.Errorf("%d open object schema(s): set additionalProperties:false, or add an "+
			"openSchemaAllowlist entry with the reason unknown keys are legitimate:\n   %s",
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
