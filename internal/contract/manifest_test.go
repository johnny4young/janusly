package contract

import "testing"

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
