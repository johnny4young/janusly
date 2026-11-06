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
		FailedAt: investigationNow.Add(-time.Hour), Now: investigationNow, Version: 1,
		ConfigKnown: true, UpstreamVisible: true,
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

const dnsError = `{"message":"Get \"https://demo-ingest.invalid/feed\": dial tcp: lookup demo-ingest.invalid: no such host"}`

func TestNetworkHypothesisRules(t *testing.T) {
	facts := baseFacts(dnsError)
	facts.Similar = []signature.ClusterSampleRef{{RunID: "run-1"}, {RunID: "run-0"}}
	facts.SimilarCount = 2
	got := verdicts(t, evaluateInvestigation(facts))
	network := got["network"]
	expect(t, network, "validated", "network_dns")
	if network.Params["count"] != 2 || len(network.Evidence) != 2 ||
		network.Evidence[0] != (InvestigationEvidence{Kind: "failed_step", RunID: "run-1", NodeID: "fetch"}) ||
		network.Evidence[1] != (InvestigationEvidence{Kind: "similar_failure", RunID: "run-0"}) {
		t.Fatalf("network evidence must cite the failed step and other runs only: %+v", network)
	}

	expect(t, verdicts(t, evaluateInvestigation(baseFacts(`{"message":"connect ECONNREFUSED 127.0.0.1:1"}`)))["network"],
		"validated", "network_unreachable")
	expect(t, verdicts(t, evaluateInvestigation(baseFacts(`{"message":"HTTP 500 from upstream"}`)))["network"],
		"ruled_out", "network_other_category")
	expect(t, verdicts(t, evaluateInvestigation(baseFacts(`{"message":"something odd"}`)))["network"],
		"inconclusive", "error_unclassified")
	expect(t, verdicts(t, evaluateInvestigation(baseFacts("")))["network"], "inconclusive", "no_error")
}

func TestCredentialHypothesisRules(t *testing.T) {
	expect(t, verdicts(t, evaluateInvestigation(baseFacts(`{"code":"E_SECRET_MISSING","secret":"billing"}`)))["credential"],
		"validated", "credential_missing")
	expect(t, verdicts(t, evaluateInvestigation(baseFacts(`{"statusCode":401}`)))["credential"],
		"validated", "credential_rejected")

	expired := baseFacts(dnsError)
	expired.Credential, expired.UsesCredential = "crm", true
	at := expired.FailedAt.Add(-time.Minute)
	expired.CredentialExpiredAt = &at
	item := verdicts(t, evaluateInvestigation(expired))["credential"]
	expect(t, item, "validated", "credential_expired")
	if item.Params["credential"] != "crm" {
		t.Fatalf("expired credential must be named: %+v", item.Params)
	}
	later := expired.FailedAt.Add(time.Minute)
	expired.CredentialExpiredAt = &later
	expect(t, verdicts(t, evaluateInvestigation(expired))["credential"], "inconclusive", "credential_unproven")

	expect(t, verdicts(t, evaluateInvestigation(baseFacts(dnsError)))["credential"], "ruled_out", "credential_unused")
	unknownConfig := baseFacts(dnsError)
	unknownConfig.ConfigKnown = false
	expect(t, verdicts(t, evaluateInvestigation(unknownConfig))["credential"], "inconclusive", "credential_unproven")
	expect(t, verdicts(t, evaluateInvestigation(baseFacts("")))["credential"], "inconclusive", "no_error")
}

func TestUpstreamHypothesisRules(t *testing.T) {
	facts := baseFacts(dnsError)
	facts.UpstreamVisible = false
	expect(t, verdicts(t, evaluateInvestigation(facts))["upstream"], "inconclusive", "upstream_hidden")

	facts = baseFacts(dnsError)
	expect(t, verdicts(t, evaluateInvestigation(facts))["upstream"], "inconclusive", "upstream_unwatched")

	facts.UpstreamTags = []string{"ingest"}
	expect(t, verdicts(t, evaluateInvestigation(facts))["upstream"], "inconclusive", "upstream_unchecked")
	facts.Upstream = []upstreamState{{Name: "ingest", Checked: true}}
	item := verdicts(t, evaluateInvestigation(facts))["upstream"]
	expect(t, item, "ruled_out", "upstream_healthy")
	if item.Params["sources"] != "ingest" {
		t.Fatalf("healthy sources must be named: %+v", item.Params)
	}
	facts.Upstream = append(facts.Upstream, upstreamState{Name: "feed", Checked: true, Degraded: true})
	expect(t, verdicts(t, evaluateInvestigation(facts))["upstream"], "validated", "upstream_degraded")

	facts.FailedAt = investigationNow.Add(-25 * time.Hour)
	expect(t, verdicts(t, evaluateInvestigation(facts))["upstream"], "inconclusive", "upstream_stale")
}

func TestChangeHypothesisRules(t *testing.T) {
	facts := baseFacts(dnsError)
	expect(t, verdicts(t, evaluateInvestigation(facts))["change"], "inconclusive", "change_no_baseline")

	facts.LastSuccessRunID, facts.LastSuccessVersion = "run-ok", 1
	item := verdicts(t, evaluateInvestigation(facts))["change"]
	expect(t, item, "ruled_out", "change_same_version")
	if len(item.Evidence) != 1 || item.Evidence[0] != (InvestigationEvidence{Kind: "last_success", RunID: "run-ok"}) {
		t.Fatalf("the baseline run must be cited: %+v", item.Evidence)
	}
	facts.Version = 2
	item = verdicts(t, evaluateInvestigation(facts))["change"]
	expect(t, item, "validated", "change_new_version")
	if item.Params["from"] != 1 || item.Params["to"] != 2 {
		t.Fatalf("version change params: %+v", item.Params)
	}
}

func TestConclusionAndActionNeedValidatedCauseAndPermission(t *testing.T) {
	facts := baseFacts(`{"message":"something odd"}`)
	facts.DeadLetterID, facts.CanFix = "dl-1", true
	if got := evaluateInvestigation(facts); got.Conclusion != "" || got.Action != nil {
		t.Fatalf("nothing validated must offer no conclusion or action: %+v", got)
	}

	facts = baseFacts(dnsError)
	facts.LastSuccessRunID, facts.LastSuccessVersion, facts.Version = "run-ok", 1, 2
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

func TestNodeCredentialReadsNamesAndSecretTemplates(t *testing.T) {
	input := []byte(`{"workflow":{"nodes":[
		{"id":"named","config":{"credential":"crm"}},
		{"id":"nested","config":{"input":{"credential":"erp"}}},
		{"id":"template","config":{"headers":{"Authorization":"Bearer {{ secret.TOKEN }}"}}},
		{"id":"plain","config":{"url":"https://example.com"}}
	]}}`)
	cases := []struct {
		node        string
		name        string
		uses, known bool
	}{
		{"named", "crm", true, true}, {"nested", "erp", true, true},
		{"template", "", true, true}, {"plain", "", false, true}, {"absent", "", false, false},
	}
	for _, tc := range cases {
		name, uses, known := nodeCredential(input, tc.node)
		if name != tc.name || uses != tc.uses || known != tc.known {
			t.Fatalf("%s = %q %v %v", tc.node, name, uses, known)
		}
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
