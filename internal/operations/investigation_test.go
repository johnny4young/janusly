package operations

import (
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/signature"
)

var investigationNow = time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)

func baseFacts(errorJSON string) investigationFacts {
	return investigationFacts{
		RunID: "run-1", NodeID: "fetch", HasError: errorJSON != "",
		Result:   signature.NormalizeJSON([]byte(errorJSON), signature.Context{NodeType: "http", NodeID: "fetch"}),
		FailedAt: investigationNow.Add(-time.Hour), Now: investigationNow, Version: 2,
		CredentialsComplete: true, UpstreamVisible: true,
	}
}

func verdicts(t *testing.T, got Investigation) map[string]Hypothesis {
	t.Helper()
	byID := map[string]Hypothesis{}
	for index, item := range got.Hypotheses {
		if item.ID != HypothesisIDs[index] {
			t.Fatalf("hypothesis %d = %s, want the fixed check order %v", index, item.ID, HypothesisIDs)
		}
		if item.Params == nil || item.Evidence == nil {
			t.Fatalf("%s has a null collection", item.ID)
		}
		byID[item.ID] = item
	}
	return byID
}

func expect(t *testing.T, item Hypothesis, verdict, reason string) {
	t.Helper()
	if item.Verdict != verdict || item.Reason != reason {
		t.Fatalf("%s = %s/%s, want %s/%s", item.ID, item.Verdict, item.Reason, verdict, reason)
	}
}

func evaluate(t *testing.T, facts investigationFacts) map[string]Hypothesis {
	t.Helper()
	return verdicts(t, evaluateInvestigation(facts))
}

const dnsError = `{"message":"Get \"https://demo-ingest.invalid/feed\": dial tcp: lookup demo-ingest.invalid: no such host"}`

func TestNetworkHypothesisCitesOnlyTheDecidingStep(t *testing.T) {
	facts := baseFacts(dnsError)
	facts.StepRuns, facts.StepSameFailures = 5, 2
	network := evaluate(t, facts)["network"]
	expect(t, network, "validated", "network_dns")
	if network.Params["count"] != 2 || network.Params["runs"] != 5 || len(network.Evidence) != 1 ||
		network.Evidence[0] != (InvestigationEvidence{Kind: "failed_step", RunID: "run-1", NodeID: "fetch"}) {
		t.Fatalf("network must cite the failed step and count this workflow's step only: %+v", network)
	}

	for _, message := range []string{"connect ECONNREFUSED 127.0.0.1:1", "context deadline exceeded"} {
		item := evaluate(t, baseFacts(`{"message":"`+message+`"}`))["network"]
		expect(t, item, "validated", "network_failed")
		if item.Params["count"] != 1 || item.Params["runs"] != 1 {
			t.Fatalf("this failure always counts once: %+v", item.Params)
		}
	}
	expect(t, evaluate(t, baseFacts(`{"message":"HTTP 500 from upstream"}`))["network"], "ruled_out", "network_other_category")
	expect(t, evaluate(t, baseFacts(`{"message":"something odd"}`))["network"], "inconclusive", "error_unclassified")
	expect(t, evaluate(t, baseFacts(""))["network"], "inconclusive", "no_error")
}

func TestCredentialHypothesisRules(t *testing.T) {
	expect(t, evaluate(t, baseFacts(`{"code":"E_SECRET_MISSING","secret":"billing"}`))["credential"],
		"validated", "credential_missing")
	expect(t, evaluate(t, baseFacts(`{"statusCode":401}`))["credential"], "validated", "credential_rejected")

	at := investigationNow.Add(-2 * time.Hour)
	rejected := baseFacts(`{"statusCode":403}`)
	rejected.ExpiredCredential, rejected.ExpiredAt, rejected.UsesCredential = "crm", &at, true
	item := evaluate(t, rejected)["credential"]
	expect(t, item, "validated", "credential_expired")
	if item.Params["credential"] != "crm" {
		t.Fatalf("expired credential must be named: %+v", item.Params)
	}

	// An expired credential is a fact, not a cause, unless a service rejected the call.
	unconfirmed := baseFacts(dnsError)
	unconfirmed.ExpiredCredential, unconfirmed.ExpiredAt, unconfirmed.UsesCredential = "crm", &at, true
	expect(t, evaluate(t, unconfirmed)["credential"], "inconclusive", "credential_expired_unconfirmed")

	expect(t, evaluate(t, baseFacts(dnsError))["credential"], "ruled_out", "credential_unused")
	used := baseFacts(dnsError)
	used.UsesCredential = true
	expect(t, evaluate(t, used)["credential"], "inconclusive", "credential_unproven")
	// AI, MCP and subworkflow steps can use credentials their bindings do not name.
	undescribed := baseFacts(dnsError)
	undescribed.CredentialsComplete = false
	expect(t, evaluate(t, undescribed)["credential"], "inconclusive", "credential_unproven")
	expect(t, evaluate(t, baseFacts(""))["credential"], "inconclusive", "no_error")
}

func TestUpstreamHypothesisNeverRulesOutFromTheLatestReading(t *testing.T) {
	facts := baseFacts(dnsError)
	facts.UpstreamVisible = false
	expect(t, evaluate(t, facts)["upstream"], "inconclusive", "upstream_hidden")

	facts = baseFacts(dnsError)
	expect(t, evaluate(t, facts)["upstream"], "inconclusive", "upstream_unwatched")

	facts.UpstreamTags = []string{"ingest"}
	expect(t, evaluate(t, facts)["upstream"], "inconclusive", "upstream_unchecked")

	near := facts.FailedAt.Add(time.Minute)
	facts.Upstream = []upstreamReading{{Name: "ingest", Successful: true, CheckedAt: &near, Interval: time.Minute}}
	item := evaluate(t, facts)["upstream"]
	expect(t, item, "inconclusive", "upstream_current_only")
	if item.Params["sources"] != "ingest" {
		t.Fatalf("read sources must be named: %+v", item.Params)
	}

	facts.Upstream[0].Degraded = true
	expect(t, evaluate(t, facts)["upstream"], "validated", "upstream_degraded")

	far := facts.FailedAt.Add(30 * time.Minute)
	facts.Upstream[0].CheckedAt = &far
	expect(t, evaluate(t, facts)["upstream"], "inconclusive", "upstream_current_only")

	// A poll error keeps the old degraded flag; it describes nothing.
	facts.Upstream[0].CheckedAt, facts.Upstream[0].Successful = &near, false
	expect(t, evaluate(t, facts)["upstream"], "inconclusive", "upstream_unchecked")
}

func TestChangeHypothesisAsksWhetherThisVersionWorkedBefore(t *testing.T) {
	facts := baseFacts(dnsError)
	facts.Version = 0
	expect(t, evaluate(t, facts)["change"], "inconclusive", "change_unsaved")

	facts = baseFacts(dnsError)
	expect(t, evaluate(t, facts)["change"], "inconclusive", "change_no_baseline")

	facts.OlderSuccess, facts.OlderVersion = "run-v1", 1
	item := evaluate(t, facts)["change"]
	expect(t, item, "validated", "change_new_version")
	if item.Params["from"] != 1 || item.Params["to"] != 2 ||
		item.Evidence[0] != (InvestigationEvidence{Kind: "last_success", RunID: "run-v1"}) {
		t.Fatalf("version change must cite the older success: %+v", item)
	}

	facts.SameVersionSuccess = "run-v2"
	item = evaluate(t, facts)["change"]
	expect(t, item, "ruled_out", "change_same_version")
	if item.Evidence[0].RunID != "run-v2" {
		t.Fatalf("the same-version success must be cited: %+v", item.Evidence)
	}
	facts.OutsideVersion = true
	expect(t, evaluate(t, facts)["change"], "inconclusive", "change_outside_version")
}

func TestConclusionAndActionNeedValidatedCauseAndPermission(t *testing.T) {
	facts := baseFacts(`{"message":"something odd"}`)
	facts.DeadLetterID, facts.CanFix = "dl-1", true
	if got := evaluateInvestigation(facts); got.Conclusion != "" || got.Action != nil {
		t.Fatalf("nothing validated must offer no conclusion or action: %+v", got)
	}

	facts = baseFacts(dnsError)
	facts.OlderSuccess, facts.OlderVersion = "run-v1", 1
	facts.DeadLetterID = "dl-1"
	if got := evaluateInvestigation(facts); got.Conclusion != "network" || got.Action != nil {
		t.Fatalf("the first validated check concludes; no permission means no action: %+v", got)
	}
	facts.CanFix = true
	got := evaluateInvestigation(facts)
	if got.Action == nil || *got.Action != (InvestigationAction{Kind: "open_recovery", DeadLetterID: "dl-1"}) {
		t.Fatalf("permitted action must target the open dead letter: %+v", got.Action)
	}
	facts.DeadLetterID = ""
	if got := evaluateInvestigation(facts); got.Action != nil {
		t.Fatalf("without an open dead letter there is nothing to fix: %+v", got.Action)
	}
}

func TestEvidenceIsUniquePerRun(t *testing.T) {
	item := hypothesis("network", "validated", "network_dns", nil,
		InvestigationEvidence{Kind: "failed_step", RunID: "run-1", NodeID: "a"},
		InvestigationEvidence{Kind: "last_success", RunID: "run-1"},
		InvestigationEvidence{Kind: "last_success", RunID: "run-2"})
	if len(item.Evidence) != 2 || item.Evidence[0].NodeID != "a" || item.Evidence[1].RunID != "run-2" {
		t.Fatalf("evidence must keep the first entry per run: %+v", item.Evidence)
	}
}

func TestSnapshotWorkflowReadsTheExecutedDefinition(t *testing.T) {
	workflow := snapshotWorkflow([]byte(`{"workflow":{"id":"wf","name":"Ingest","dslVersion":"1.0",
		"nodes":[{"id":"fetch","type":"http","config":{"url":"https://example.com"}}],"edges":[]}}`))
	if workflow == nil || workflow.Name != "Ingest" || len(workflow.Nodes) != 1 || workflow.Nodes[0].Type != "http" {
		t.Fatalf("snapshot workflow = %+v", workflow)
	}
	if snapshotWorkflow([]byte(`{"input":{}}`)) != nil || snapshotWorkflow([]byte(`not json`)) != nil {
		t.Fatal("a missing or unreadable snapshot must be nil")
	}
}

func TestEarlierPrefersTheFirstFinishedFailure(t *testing.T) {
	first, second := investigationNow.Add(-time.Minute), investigationNow
	cases := []struct {
		left, right *time.Time
		want        bool
	}{
		{&first, &second, true}, {&second, &first, false}, {&first, nil, true}, {nil, &first, false}, {nil, nil, false},
	}
	for index, tc := range cases {
		if got := earlier(tc.left, tc.right); got != tc.want {
			t.Fatalf("case %d: earlier = %v, want %v", index, got, tc.want)
		}
	}
}

func TestFailureTimeFallsBackToTheRunStart(t *testing.T) {
	finished, created := investigationNow.Add(-time.Hour), investigationNow.Add(-2*time.Hour)
	if got := failureTime(&finished, &created, investigationNow); !got.Equal(finished) {
		t.Fatalf("finished step = %v", got)
	}
	if got := failureTime(nil, &created, investigationNow); !got.Equal(created) {
		t.Fatalf("unfinished step must use the run start, got %v", got)
	}
}
