package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/contract"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/health"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/memory"
	"github.com/johnny4young/janusly/internal/operations"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

// conformanceRow proves one manifest route against the wire its handler
// renders. Unit fixtures come from the real typed views and pure cores;
// integration rows are exercised against PostgreSQL in
// manifest_conformance_integration_test.go.
type conformanceRow struct {
	fixtures    func(t *testing.T) []any
	integration bool
}

var conformanceInstant = time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)

func onlyIntegration() conformanceRow { return conformanceRow{integration: true} }

func coreData(t *testing.T, result opResult) any {
	t.Helper()
	if result.status != 0 && (result.status < 200 || result.status > 299) {
		t.Fatalf("core failed: %d %s %s", result.status, result.code, result.message)
	}
	return listWire(t, result.data)
}

// postToCore runs a pool-free core against a real request body.
func postToCore(t *testing.T, core func(*http.Request) opResult, path, body string) any {
	t.Helper()
	return coreData(t, core(httptest.NewRequest("POST", path, strings.NewReader(body))))
}

func conformanceRecoveryCase() store.RecoveryCase {
	return store.RecoveryCase{
		ID: "case-1", OrgID: "org", RunID: "run", WorkflowID: pgtype.Text{String: "workflow", Valid: true},
		WorkflowVersionID: "version", Source: "semantic_violation", DetectorID: "detector",
		SourceNodeID: "node", DetectorKind: "expression", Action: "quarantine", Message: "violation",
		DetailsJson: json.RawMessage(`{"expected":"ok"}`), State: "diagnosed", Revision: 2,
		CreatedAt: conformanceInstant, UpdatedAt: conformanceInstant,
	}
}

func conformanceArtifact(kind string) store.RecoveryCaseArtifact {
	return store.RecoveryCaseArtifact{
		ID: kind + "-1", OrgID: "org", CaseID: "case-1", Kind: kind,
		PayloadJson: json.RawMessage(`{"mode":"deterministic_fallback"}`), PayloadSha256: strings.Repeat("a", 64),
		ActorKind: "user", ActorID: pgtype.Text{String: "operator", Valid: true}, CreatedAt: conformanceInstant,
	}
}

// The "before" window has no runs, so its signals are the zero value.
func conformanceHealthScores() (health.Score, health.Score, health.Signals) {
	p95, target, window := 1200.0, 95.0, 14
	slo := &health.Slo{SuccessRatePercent: &target, WindowDays: &window}
	before := health.Signals{}
	after := health.Signals{
		TotalRuns: 10, SuccessCount: 8, FailureCount: 2, RetryCount: 1, DlqOpenCount: 1,
		P95LatencyMs: &p95, TotalCostUsd: 0.4, TotalTokens: 1200, VersionCount: 2,
	}
	facts := health.WorkflowFacts{AiNodeCount: 1, HasApprovalNode: true}
	issues := []health.ReadinessIssue{{Code: "workflow_missing_outputs", Severity: "warn"}}
	return health.Compute(facts, issues, before, nil), health.Compute(facts, issues, after, slo), after
}

func conformanceQualificationSummary() recovery.QualificationSummary {
	return recovery.QualificationSummary{
		DatasetVersion: "1", DatasetDigest: strings.Repeat("b", 64), Mode: "compare", Status: "failed",
		BaselineCaseCount: 1, CandidateCaseCount: 1, CandidateAssertionCount: 2,
		PassedCandidateAssertions: 1, FailedCandidateAssertions: 1, RegressionCount: 1,
		BaselineDatasetValid: true, FailuresTruncated: false,
		Failures: []recovery.QualificationFailure{{
			Dataset: "baseline", FixtureID: "fixture", SourceNodeID: "node",
			Expected: "pass", Actual: "violation", Reason: "regression",
			Violations: []recovery.SemanticOutcomeViolation{{
				DetectorID: "detector", SourceNodeID: "node", Kind: "expression",
				Action: "quarantine", Message: "violated", Details: []string{"total"},
			}},
		}},
	}
}

func manifestConformanceRows() map[string]conformanceRow {
	listRow := func(path string) conformanceRow {
		return conformanceRow{integration: true, fixtures: func(t *testing.T) []any {
			return []any{listWire(t, listViewFixtures()[path])}
		}}
	}
	caseView := func() map[string]any { return recoveryCaseView(conformanceRecoveryCase()) }
	server := &V1Server{}
	validate := func(r *http.Request) opResult { return server.validateCore(r, v1Request{}) }
	readiness := func(r *http.Request) opResult { return server.readinessCore(r, v1Request{}) }
	compile := func(r *http.Request) opResult { return server.compileWorkflowBriefCore(r, v1Request{}) }
	rolloutRow := conformanceRow{integration: true, fixtures: func(t *testing.T) []any {
		reason := pgtype.Text{String: "canary regressed", Valid: true}
		active := store.WorkflowRollout{
			ID: "rollout", WorkflowID: "workflow", BaselineVersionID: "v1", CanaryVersionID: "v2",
			TrafficPercent: 10, MinimumSampleSize: 5, MinimumSuccessRatePercent: 90, Status: "active",
			CreatedAt: conformanceInstant, UpdatedAt: conformanceInstant,
		}
		ended := active
		ended.Status, ended.RolledBackReason = "rolled_back", reason
		ended.EndedAt, ended.LastOutcomeAt = &conformanceInstant, &conformanceInstant
		return []any{
			listWire(t, map[string]any{"rollout": rolloutView(active)}),
			listWire(t, map[string]any{"rollout": rolloutView(ended)}),
		}
	}}
	qualificationRow := conformanceRow{integration: true, fixtures: func(t *testing.T) []any {
		summary := conformanceQualificationSummary()
		receipt, err := json.Marshal(recovery.ToReceiptSummary(summary))
		if err != nil {
			t.Fatal(err)
		}
		row := store.WorkflowRecoveryQualification{
			ID: "qualification", WorkflowID: "workflow", BaselineVersionID: "v1", CandidateVersionID: "v2",
			DatasetVersion: "1", DatasetDigest: summary.DatasetDigest, Mode: "compare", Status: "failed",
			SummaryJson: receipt, CreatedAt: conformanceInstant,
		}
		notRequired := recovery.QualifyRecoveryCandidate(&domain.Workflow{}, &domain.Workflow{})
		return []any{
			listWire(t, map[string]any{"required": true, "qualification": qualificationView(row)}),
			listWire(t, map[string]any{"required": true, "qualification": nil}),
			listWire(t, map[string]any{"required": false, "qualification": nil, "summary": notRequired}),
		}
	}}

	return map[string]conformanceRow{
		"GET /v1/workflows":          listRow("/v1/workflows"),
		"GET /v1/workflows/versions": listRow("/v1/workflows/versions"),
		"GET /v1/templates":          listRow("/v1/templates"),
		"GET /v1/tools":              listRow("/v1/tools"),
		"GET /v1/runs":               listRow("/v1/runs"),
		"GET /v1/workflows/latest": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{listWire(t, listViewFixtures()["/v1/workflows/versions"]).([]any)[0]}
		}},
		"GET /v1/run":    {integration: true, fixtures: func(t *testing.T) []any { return []any{runSnapshotFixture(t)} }},
		"GET /v1/status": {integration: true, fixtures: func(t *testing.T) []any { return []any{runSnapshotFixture(t)} }},
		"GET /v1/dlq": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{listWire(t, []DeadLetterSummaryView{newDeadLetterSummaryView(store.ListDeadLetterSummariesRow{
				ID: "letter", OrgID: "org", RunID: "run", NodeID: "node", Status: "open", Attempt: 1,
			})})}
		}},
		"GET /v1/dlq/entries/{deadLetterId}": {integration: true, fixtures: func(t *testing.T) []any { return []any{dlqDetailFixture(t)} }},
		"POST /v1/validate": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{
				postToCore(t, validate, "/v1/validate", `{"workflow":{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[]}}`),
				postToCore(t, validate, "/v1/validate", `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[{"from":"a","to":"ghost"}]}`),
				postToCore(t, validate, "/v1/validate", `{"workflow":{"nodes":"invalid"}}`),
			}
		}},
		"POST /v1/workflows/readiness": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{
				postToCore(t, readiness, "/v1/workflows/readiness", `{"workflow":{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[{"id":"e","from":"a","to":"ghost"}]}}`),
				postToCore(t, readiness, "/v1/workflows/readiness", `{"workflow":{"nodes":"invalid"}}`),
			}
		}},
		"GET /v1/workflows/health": {integration: true, fixtures: func(t *testing.T) []any {
			before, after, _ := conformanceHealthScores()
			return []any{listWire(t, before), listWire(t, after)}
		}},
		"GET /v1/workflows/health/delta": {integration: true, fixtures: func(t *testing.T) []any {
			before, after, afterSignals := conformanceHealthScores()
			complete := workflowHealthDelta{
				WorkflowID: "workflow", AfterVersion: 2, WindowDays: 30, HasEnoughData: true,
				Before: before, After: after, Delta: buildRecoveryDelta(before, after, health.Signals{}, afterSignals),
				RecentRunsAgainstAfter: recentRunsAgainstAfter{TotalRuns: 10, Succeeded: 8, Failed: 2},
				SameFailureSinceApply:  &sameFailureSinceApply{Count: 1, SampleDeadLetterIDs: []string{"letter"}, PriorSignature: "sig"},
				PriorVersion:           &priorWorkflowVersion{Version: 1, VersionID: "v1"},
			}
			gathering := workflowHealthDelta{WorkflowID: "workflow", AfterVersion: 1, WindowDays: 30, Before: before, After: before}
			return []any{listWire(t, complete), listWire(t, gathering)}
		}},
		"GET /v1/workflows/versions/{versionId}":                         onlyIntegration(),
		"POST /v1/workflows/save":                                        onlyIntegration(),
		"POST /v1/workflows/rollback":                                    onlyIntegration(),
		"POST /v1/workflows/{id}/resume":                                 onlyIntegration(),
		"POST /v1/workflows/{workflowId}/rollout":                        rolloutRow,
		"POST /v1/workflows/{workflowId}/rollout/{rolloutId}/{decision}": rolloutRow,
		"GET /v1/workflows/{workflowId}/rollout/qualification":           qualificationRow,
		"POST /v1/workflows/{workflowId}/rollout/qualification":          qualificationRow,
		"POST /v1/start":                       onlyIntegration(),
		"POST /v1/webhooks/{workflowId}":       onlyIntegration(),
		"POST /v1/triggers/email/ingest":       onlyIntegration(),
		"POST /v1/triggers/file/ingest":        onlyIntegration(),
		"POST /v1/triggers/mcp/ingest":         onlyIntegration(),
		"POST /v1/resume":                      onlyIntegration(),
		"POST /v1/run/cancel":                  onlyIntegration(),
		"POST /v1/dlq/resolve":                 onlyIntegration(),
		"POST /v1/dlq/redrive":                 onlyIntegration(),
		"POST /v1/dlq/replay":                  onlyIntegration(),
		"POST /v1/runs/redrive":                onlyIntegration(),
		"POST /v1/dlq/validate-fix":            onlyIntegration(),
		"POST /v1/ai/patch-workflow":           onlyIntegration(),
		"POST /v1/recovery/playbooks/{id}/use": onlyIntegration(),
		"GET /v1/dlq/clusters": {integration: true, fixtures: func(t *testing.T) []any {
			samples := []signature.FailureSample{
				{Source: "dead_letter", ID: "letter", WorkflowID: "workflow", WorkflowName: "Billing",
					RunID: "run", NodeID: "call", NodeType: "http", ErrorJSON: []byte(`{"message":"timeout after 30s"}`), CreatedAt: conformanceInstant},
				{Source: "failed_run_node", ID: "run-2:call", WorkflowID: "workflow", RunID: "run-2", NodeID: "call",
					ErrorJSON: []byte(`{"message":"timeout after 31s"}`), CreatedAt: conformanceInstant},
			}
			clusters := []homeCluster{}
			for _, cluster := range signature.ClusterFailureSamples(samples) {
				clusters = append(clusters, homeCluster{FailureCluster: cluster, RecurredAfterRecovery: true})
			}
			return []any{listWire(t, map[string]any{"clusters": clusters, "totalSamples": len(samples), "windowDays": 30})}
		}},
		"GET /v1/runs/semantic-search": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{
				listWire(t, map[string]any{"enabled": true, "entries": []memory.RecallEntry{{
					ID: "memory", Kind: "run_summary", Content: "failed on timeout", WorkflowID: "workflow",
					RunID: "run", Similarity: 0.82, Metadata: map[string]any{"status": "failed"},
				}}}),
				listWire(t, map[string]any{"enabled": false, "entries": []memory.RecallEntry{}}),
			}
		}},
		"GET /v1/recovery/home": onlyIntegration(),
		"GET /v1/recovery/cases": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{listWire(t, map[string]any{"cases": []map[string]any{caseView()}})}
		}},
		"GET /v1/recovery/cases/{caseId}": onlyIntegration(),
		"POST /v1/recovery/cases/{caseId}/diagnose": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{listWire(t, map[string]any{
				"case": caseView(), "diagnosis": recoveryArtifactView(conformanceArtifact("diagnosis")),
				"mode": "ai_enriched",
			})}
		}},
		"POST /v1/recovery/cases/{caseId}/candidates": {fixtures: func(t *testing.T) []any {
			return []any{listWire(t, map[string]any{
				"case": caseView(), "candidates": []map[string]any{recoveryArtifactView(conformanceArtifact("candidate"))},
			})}
		}},
		"POST /v1/recovery/cases/{caseId}/validate": {fixtures: func(t *testing.T) []any {
			return []any{listWire(t, map[string]any{
				"case": caseView(), "validation": recoveryArtifactView(conformanceArtifact("validation")), "passed": true,
			})}
		}},
		"POST /v1/recovery/cases/{caseId}/approve": {fixtures: func(t *testing.T) []any {
			grant := store.RecoveryApprovalGrant{
				ID: "grant", CaseID: "case-1", CaseRevision: 3, CandidateArtifactID: "candidate-1",
				ValidationArtifactID: "validation-1", ExpiresAt: conformanceInstant,
			}
			return []any{listWire(t, map[string]any{"approval": map[string]any{
				"id": grant.ID, "caseId": grant.CaseID, "caseRevision": grant.CaseRevision,
				"candidateArtifactId": grant.CandidateArtifactID, "validationArtifactId": grant.ValidationArtifactID,
				"expiresAt": grant.ExpiresAt,
			}})}
		}},
		"POST /v1/recovery/cases/{caseId}/apply": {fixtures: func(t *testing.T) []any {
			return []any{listWire(t, map[string]any{
				"runId": "run", "sourceNodeId": "node", "decision": "replace_output",
				"resumed": true, "resolvedCaseIds": []string{"case-1"},
			})}
		}},
		"GET /v1/recovery/metrics":           onlyIntegration(),
		"GET /v1/recovery/ledger":            onlyIntegration(),
		"GET /v1/recovery/my-wins":           onlyIntegration(),
		"GET /v1/memory/consent-status":      onlyIntegration(),
		"GET /v1/run/usage":                  onlyIntegration(),
		"GET /v1/workflows/schedule-preview": onlyIntegration(),
		"GET /v1/authoring/capabilities": {integration: true, fixtures: func(t *testing.T) []any {
			catalog := (&authoring.Builder{Registry: executors.SharedToolRegistry(), Now: func() time.Time { return conformanceInstant }}).
				Build(context.Background(), "org")
			expires := conformanceInstant.Add(time.Hour)
			catalog.Credentials = append(catalog.Credentials,
				authoring.CredentialCapability{ID: "c1", Name: "crm", Kind: "api_key", Configured: true, ExpiresAt: &expires, UpdatedAt: conformanceInstant},
				authoring.CredentialCapability{ID: "c2", Name: "mail", Kind: "oauth", UpdatedAt: conformanceInstant})
			catalog.McpTools = append(catalog.McpTools, mcpclient.ExposedMcpTool{
				ConnectionAlias: "crm", ToolName: "lookup", Description: "Find an account",
				InputFields: []mcpclient.ExposedMcpInputField{{Name: "id", Type: "string", Required: true}},
			})
			catalog.Subworkflows = append(catalog.Subworkflows, authoring.SubworkflowCapability{
				WorkflowID: "child", Name: "Child", Status: "active", LatestVersion: 3,
			})
			return []any{listWire(t, catalog)}
		}},
		"POST /v1/ai/workflow-briefs/compile": {integration: true, fixtures: func(t *testing.T) []any {
			return []any{
				postToCore(t, compile, "/v1/ai/workflow-briefs/compile", `{"prompt":"When an invoice email arrives, extract the total and post it to the ledger after a manager approves."}`),
				postToCore(t, compile, "/v1/ai/workflow-briefs/compile", `{}`),
			}
		}},
		"POST /v1/ai/workflow-proposals": onlyIntegration(),
		"GET /v1/operations/brief": {integration: true, fixtures: func(t *testing.T) []any {
			action := func(id string, params map[string]any) operations.Action {
				return operations.Action{
					ID: id, Kind: "recovery_case", Priority: 1, Severity: "high",
					TitleKey: "brief.title", BodyKey: "brief.body", CTAKey: "brief.cta", Params: params,
					Evidence:       []operations.Evidence{{Kind: "case", ID: id, Key: "state", Value: "diagnosed"}},
					Target:         operations.Target{Kind: "recovery_case", ID: id, RunID: "run", Destination: "recovery"},
					AllowedActions: []string{"open"}, CreatedAt: conformanceInstant.Format(time.RFC3339),
				}
			}
			return []any{listWire(t, operations.Brief{
				Version: "1", GeneratedAt: conformanceInstant.Format(time.RFC3339), Warnings: []string{},
				Actions: []operations.Action{
					action("a", map[string]any{"state": "diagnosed", "action": "quarantine"}),
					action("b", map[string]any{"count": 3, "category": "timeout"}),
					action("c", map[string]any{}),
				},
			})}
		}},
	}
}

func TestEveryManifestRouteHasWireConformance(t *testing.T) {
	rows := manifestConformanceRows()
	declared := map[string]bool{}
	var missing, stale, empty []string
	for _, route := range contract.Routes {
		key := route.Method + " " + route.Path
		declared[key] = true
		row, ok := rows[key]
		switch {
		case !ok:
			missing = append(missing, key)
		case row.fixtures == nil && !row.integration:
			empty = append(empty, key)
		}
	}
	for key := range rows {
		if !declared[key] {
			stale = append(stale, key)
		}
	}
	for _, list := range [][]string{missing, stale, empty} {
		sort.Strings(list)
	}
	if len(missing)+len(stale)+len(empty) > 0 {
		t.Fatalf("conformance table drift:\n missing: %v\n stale: %v\n without proof: %v", missing, stale, empty)
	}
}

// injectUnknownWireKey adds a key no closed schema declares, at the top level
// or inside the first row of a list.
func injectUnknownWireKey(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		typed["unexpectedWireKey"] = true
		return true
	case []any:
		if len(typed) > 0 {
			return injectUnknownWireKey(typed[0])
		}
	}
	return false
}

func requireUnknownWireKeyRejected(t *testing.T, method, path string, data any) {
	t.Helper()
	mutated := listWire(t, data)
	if !injectUnknownWireKey(mutated) {
		return
	}
	if err := resolvedManifestSchema(t, method, path).Validate(mutated); err == nil {
		t.Fatalf("%s %s accepted an undeclared wire key", method, path)
	}
}

func TestManifestConformanceUnitFixtures(t *testing.T) {
	for key, row := range manifestConformanceRows() {
		if row.fixtures == nil {
			continue
		}
		method, path, _ := strings.Cut(key, " ")
		t.Run(key, func(t *testing.T) {
			fixtures := row.fixtures(t)
			if len(fixtures) == 0 {
				t.Fatal("fixture row produced no payload")
			}
			for _, data := range fixtures {
				requireManifestDataFor(t, method, path, data)
				requireUnknownWireKeyRejected(t, method, path, data)
			}
		})
	}
}

// Metric projections are pure; their populated branches are rarely reached
// by an empty integration tenant, so each is checked against its property.
func TestRecoveryMetricProjectionsMatchManifest(t *testing.T) {
	schema := manifestResponse(t, "GET", "/v1/recovery/metrics")
	properties, _ := schema["properties"].(map[string]any)
	signals := store.QueryRecoveryDashboardSignalsRow{
		Succeeded: 9, Failed: 1, ReplayedSuccess: 3, ReplayedAndReopened: 1,
		P95LatencyMs: 1500, ApprovalsPending: 2, SlaResolved: 4, SlaMet: 3,
	}
	stats := store.QueryVerifiedRecoveryStatsRow{SampleSize: 3, P50Ms: 60_000, P90Ms: 120_000, MttrAvgMs: 70_000, DowntimeEndedMs: 1000}
	firstAction := store.QueryTimeToFirstActionRow{SampleSize: 2, AvgSeconds: 30, P95Seconds: 45}
	// recoveryMetricsValue adds these keys after the projection.
	withFirstAction := func(metric map[string]any, sampleSize int32, avg, p95 any) map[string]any {
		metric["unit"], metric["sampleSize"] = "seconds", sampleSize
		metric["avgSeconds"], metric["p95Seconds"] = avg, p95
		return metric
	}
	cases := map[string][]map[string]any{
		"successRate":      {successRateProjection(signals), successRateProjection(store.QueryRecoveryDashboardSignalsRow{})},
		"verifiedRecovery": {verifiedRecoveryProjection(stats), verifiedRecoveryProjection(store.QueryVerifiedRecoveryStatsRow{})},
		"mttr":             {mttrProjection(stats), mttrProjection(store.QueryVerifiedRecoveryStatsRow{})},
		"p95Latency":       {latencyProjection(1500), latencyProjection(-1)},
		"approvalsPending": {approvalsProjection(2), approvalsProjection(0)},
		"replayRate":       {replayProjection(signals), replayProjection(store.QueryRecoveryDashboardSignalsRow{})},
		"slaAttainment":    {slaProjection(4, 3), slaProjection(0, 0)},
		"timeToFirstAction": {
			withFirstAction(firstActionProjection(firstAction), firstAction.SampleSize, firstAction.AvgSeconds, firstAction.P95Seconds),
			withFirstAction(firstActionProjection(store.QueryTimeToFirstActionRow{}), 0, nil, nil),
		},
		"recurrenceRate":   {recurrenceProjection(4, 1), recurrenceProjection(0, 0)},
		"clustersResolved": {resolvedClusterProjection([]store.ListResolvedRecoveryFailureRowsRow{{NodeID: "n", ErrorJson: []byte(`{"message":"boom"}`)}})},
	}
	for name, metrics := range cases {
		raw, err := json.Marshal(properties[name])
		if err != nil {
			t.Fatal(err)
		}
		resolved := resolveSchemaJSON(t, raw)
		for _, metric := range metrics {
			if err := resolved.Validate(listWire(t, metric)); err != nil {
				t.Errorf("%s projection violates manifest: %v", name, err)
			}
		}
	}
}
