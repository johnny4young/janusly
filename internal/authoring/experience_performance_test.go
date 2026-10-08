package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// This is an engineering screen for the rules/copy components, not HTTP load,
// database latency, process startup, model quality or a speedup benchmark.
func TestExperienceRulesPerformanceUnderAuthoringWorkload(t *testing.T) {
	request, _ := decisionFixture(t)
	request.Brief = registryBrief()
	key, err := CanonicalExperienceKey(request.Brief)
	if err != nil {
		t.Fatal(err)
	}
	request.Candidates[0].BriefKey = key
	source := ExperienceArtifact{Candidate: request.Candidates[0], Document: json.RawMessage(`{"dslVersion":"1.0","id":"wf-a","nodes":[{"id":"done","type":"noop","config":{}}],"edges":[]}`)}
	catalog := NewBuilder(nil, nil).Build(t.Context(), request.OrganizationID)
	for i := range maxDynamicCatalogEntries {
		catalog.Credentials = append(catalog.Credentials, CredentialCapability{ID: fmt.Sprintf("credential-%d", i), Name: "Synthetic", Kind: "http", Configured: true})
		catalog.Subworkflows = append(catalog.Subworkflows, SubworkflowCapability{WorkflowID: fmt.Sprintf("workflow-%d", i), Name: "Synthetic", Status: "active", LatestVersion: 3})
	}
	catalog.Version = catalogDigest(catalog)
	request.CatalogVersion = catalog.Version
	// Build fixture facts without invoking RulesProvider; the measured call is
	// the first rules decision in this test (fresh test processes qualify cold).
	coldStart := time.Now()
	receipt, err := ProposeDecision(t.Context(), RulesProvider{}, request)
	cold := time.Since(coldStart)
	if err != nil || receipt.Mode != DecisionReuse || cold > DecisionStageTimeout {
		t.Fatalf("cold decision: mode=%s duration=%s error=%v", receipt.Mode, cold, err)
	}

	load, stop := context.WithCancel(t.Context())
	ready := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		first := true
		for load.Err() == nil {
			compiled, err := CompileBrief(CompileBriefRequest{Brief: registryBrief()})
			if err != nil || !compiled.Complete {
				finished <- fmt.Errorf("concurrent brief compilation: complete=%t error=%w", compiled.Complete, err)
				return
			}
			document, err := json.Marshal(DeterministicWorkflow("wait five minutes without external effects"))
			if err != nil {
				finished <- err
				return
			}
			workflow, issues := domain.Parse(document)
			if len(issues) > 0 || !workflowvalidation.Validate(workflow).Valid || !BindProposal(catalog, compiled.Brief, workflow).Complete {
				finished <- errors.New("concurrent existing proposal failed validation/binding")
				return
			}
			if first {
				close(ready)
				first = false
			}
		}
		finished <- nil
	}()
	t.Cleanup(func() {
		stop()
		if err := <-finished; err != nil {
			t.Error(err)
		}
	})
	select {
	case <-ready:
	case <-t.Context().Done():
		t.Fatal(t.Context().Err())
	case err := <-finished:
		finished <- err
		t.Fatal(err)
	}

	durations := make([]time.Duration, 1000)
	for i := range durations {
		start := time.Now()
		receipt, err := ProposeDecision(load, RulesProvider{}, request)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := CopyExperienceProposal(load, request, receipt, source, fmt.Sprintf("draft-%d", i), catalog); err != nil {
			t.Fatal(err)
		}
		durations[i] = time.Since(start)
		if durations[i] > DecisionStageTimeout {
			t.Fatalf("rules/copy exceeded unchanged stage ceiling: %s", durations[i])
		}
	}
	cancelled, cancel := context.WithCancel(load)
	cancel()
	if _, err := ProposeDecision(cancelled, RulesProvider{}, request); !errors.Is(err, context.Canceled) {
		t.Fatalf("rules cancellation: %v", err)
	}
	if _, err := CopyExperienceProposal(cancelled, request, receipt, source, "cancelled", catalog); !errors.Is(err, context.Canceled) {
		t.Fatalf("copy cancellation: %v", err)
	}
	slices.Sort(durations)
	report, err := json.Marshal(map[string]any{
		"scope":          "rules_copy_under_existing_compile_bind_validate_component_workload",
		"coldDecisionNs": cold.Nanoseconds(), "warmDecisions": len(durations),
		"warmP50Ns": durations[499].Nanoseconds(), "warmP95Ns": durations[949].Nanoseconds(),
		"warmMaxNs": durations[999].Nanoseconds(), "credentials": len(catalog.Credentials),
		"subworkflows": len(catalog.Subworkflows), "stageBudgetNs": DecisionStageTimeout.Nanoseconds(),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("performance-screen: %s", report)
}
