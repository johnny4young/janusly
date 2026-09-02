package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/health"
)

func TestParseIntegerNumberMatchesCompatibilityQuerySemantics(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
		ok   bool
	}{
		{raw: "2", want: 2, ok: true},
		{raw: "2.0", want: 2, ok: true},
		{raw: "1e1", want: 10, ok: true},
		{raw: "0", want: 0, ok: true},
		{raw: "", ok: false},
		{raw: "1.5", ok: false},
		{raw: "NaN", ok: false},
		{raw: "2147483648", ok: false},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			got, ok := parseIntegerNumber(tc.raw)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("parseIntegerNumber(%q) = %d,%v; want %d,%v", tc.raw, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestBuildRecoveryDeltaHonorsSampleAndNullableMetricContracts(t *testing.T) {
	beforeScore, afterScore := health.Score{Score: 82}, health.Score{Score: 79}
	beforeSignals := health.Signals{TotalRuns: 2, TotalCostUsd: 10}
	afterSignals := health.Signals{TotalRuns: health.MinRunsForDelta - 1, TotalCostUsd: 20}
	if delta := buildRecoveryDelta(beforeScore, afterScore, beforeSignals, afterSignals); delta != nil {
		t.Fatalf("below sample floor must be null: %+v", delta)
	}

	afterSignals.TotalRuns = health.MinRunsForDelta
	delta := buildRecoveryDelta(beforeScore, afterScore, beforeSignals, afterSignals)
	if delta == nil || delta.Score != -3 || delta.P95LatencyMs != nil || delta.CostPerRunUsd == nil ||
		*delta.CostPerRunUsd != -1 {
		t.Fatalf("nullable/cost delta: %+v", delta)
	}
	beforeP95, afterP95 := 1250.0, 1000.0
	beforeSignals.P95LatencyMs, afterSignals.P95LatencyMs = &beforeP95, &afterP95
	delta = buildRecoveryDelta(beforeScore, afterScore, beforeSignals, afterSignals)
	if delta.P95LatencyMs == nil || *delta.P95LatencyMs != -250 {
		t.Fatalf("p95 delta: %+v", delta)
	}

	beforeSignals.TotalRuns = 0
	delta = buildRecoveryDelta(beforeScore, afterScore, beforeSignals, afterSignals)
	if delta.CostPerRunUsd != nil {
		t.Fatalf("missing baseline cost-per-run must stay null: %+v", delta)
	}
}

func TestParsePersistedWorkflowSloReusesTheClosedWriteContract(t *testing.T) {
	valid := json.RawMessage(`{
		"successRatePercent":99.5,
		"mttrSeconds":120,
		"p95DurationMs":5000,
		"budgetBlocksPerWindow":null,
		"stuckWaitingNodesMax":0,
		"windowDays":30
	}`)
	slo, err := parsePersistedWorkflowSlo(valid)
	if err != nil || slo == nil || slo.SuccessRatePercent == nil || *slo.SuccessRatePercent != 99.5 ||
		slo.MttrSeconds == nil || *slo.MttrSeconds != 120 || slo.P95DurationMs == nil ||
		*slo.P95DurationMs != 5000 || slo.BudgetBlocksPerWindow != nil ||
		slo.StuckWaitingNodesMax == nil || *slo.StuckWaitingNodesMax != 0 ||
		slo.WindowDays == nil || *slo.WindowDays != 30 {
		t.Fatalf("valid persisted SLO = %+v, err=%v", slo, err)
	}
	if cleared, err := parsePersistedWorkflowSlo(json.RawMessage(`null`)); err != nil || cleared != nil {
		t.Fatalf("null SLO must remain undeclared: %+v err=%v", cleared, err)
	}
	for name, raw := range map[string]json.RawMessage{
		"sql null":               nil,
		"empty raw message":      {},
		"whitespace raw message": json.RawMessage(" \n\t"),
	} {
		t.Run(name, func(t *testing.T) {
			if undeclared, err := parsePersistedWorkflowSlo(raw); err != nil || undeclared != nil {
				t.Fatalf("absent SLO must remain undeclared: %+v err=%v", undeclared, err)
			}
		})
	}
	for name, raw := range map[string]json.RawMessage{
		"missing":     json.RawMessage(`{"windowDays":30}`),
		"unknown":     json.RawMessage(`{"successRatePercent":null,"mttrSeconds":null,"p95DurationMs":null,"budgetBlocksPerWindow":null,"stuckWaitingNodesMax":null,"windowDays":30,"extra":true}`),
		"bad window":  json.RawMessage(`{"successRatePercent":null,"mttrSeconds":null,"p95DurationMs":null,"budgetBlocksPerWindow":null,"stuckWaitingNodesMax":null,"windowDays":15}`),
		"bad integer": json.RawMessage(`{"successRatePercent":null,"mttrSeconds":1.5,"p95DurationMs":null,"budgetBlocksPerWindow":null,"stuckWaitingNodesMax":null,"windowDays":30}`),
	} {
		t.Run(name, func(t *testing.T) {
			if parsed, err := parsePersistedWorkflowSlo(raw); err == nil || parsed != nil {
				t.Fatalf("malformed persisted SLO accepted: %+v err=%v", parsed, err)
			}
		})
	}
}

func TestRecoveryFeedbackBodyRejectsExplicitNullsAndScrubsMemoryContent(t *testing.T) {
	validJSON := `{"deadLetterId":"dlq","suggestionMode":"ai","approachLabel":"add_retry","accepted":true}`
	var body recoveryFeedbackBody
	if err := json.Unmarshal([]byte(validJSON), &body); err != nil || !validRecoveryFeedbackBody(body) {
		t.Fatalf("valid feedback rejected: err=%v body=%+v", err, body)
	}
	for _, field := range []string{"comment", "rationale", "evalConsent", "rawConfidence"} {
		raw := strings.TrimSuffix(validJSON, "}") + `,"` + field + `":null}`
		body = recoveryFeedbackBody{}
		if err := json.Unmarshal([]byte(raw), &body); err != nil {
			t.Fatalf("decode %s null: %v", field, err)
		}
		if validRecoveryFeedbackBody(body) {
			t.Fatalf("explicit null %s must be rejected: %+v", field, body)
		}
	}
	var exponentialConfidence recoveryFeedbackBody
	if err := json.Unmarshal([]byte(strings.TrimSuffix(validJSON, "}")+`,"rawConfidence":8.7e1}`),
		&exponentialConfidence); err != nil || !validRecoveryFeedbackBody(exponentialConfidence) ||
		exponentialConfidence.RawConfidence.Value != 87 {
		t.Fatalf("integral JSON-number confidence must be accepted: err=%v body=%+v", err, exponentialConfidence)
	}

	secret := "sk-" + strings.Repeat("a", 24)
	recovery := composeRecoveryMemoryContent("add_retry", "use "+secret, "HTTP 401 "+secret)
	patch := composePatchMemoryContent("add_retry", "Bearer "+strings.Repeat("b", 20))
	for name, content := range map[string]string{"recovery": recovery, "patch": patch} {
		if strings.Contains(content, "sk-") || strings.Contains(content, "Bearer ") ||
			!strings.Contains(content, "[redacted]") {
			t.Fatalf("%s memory was not scrubbed: %q", name, content)
		}
	}
}
