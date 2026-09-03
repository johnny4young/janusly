package aidiagnosis

import (
	"context"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/ai"
)

type scriptedClient struct {
	responses []string
	calls     []ai.GenerateTextInput
	nilResult bool
}

func (s *scriptedClient) Configured() bool { return true }

func (s *scriptedClient) GenerateText(_ context.Context, input ai.GenerateTextInput) (*ai.GenerateTextResult, *ai.AIError) {
	s.calls = append(s.calls, input)
	index := len(s.calls) - 1
	if index >= len(s.responses) {
		return nil, &ai.AIError{Class: "unexpected", Message: "too many calls"}
	}
	if s.nilResult {
		return nil, nil
	}
	cost := 0.01
	return &ai.GenerateTextResult{
		Text: s.responses[index], Provider: "anthropic", Model: ai.DefaultModel,
		Usage:     ai.Usage{InputTokens: 20, OutputTokens: 10, TotalTokens: 30},
		LatencyMs: 4, CostUsd: &cost,
	}, nil
}

func TestGenerateTreatsNilProviderResultAsClassifiedFailure(t *testing.T) {
	client := &scriptedClient{responses: []string{"unused"}, nilResult: true}
	result, aiErr := Generate(context.Background(), client, GenerateInput{Evidence: Evidence{Message: "mismatch"}})
	if aiErr == nil || aiErr.Class != "unknown" || len(client.calls) != 1 || len(result.Calls) != 0 {
		t.Fatalf("nil provider result must fail closed: result=%+v err=%v calls=%d", result, aiErr, len(client.calls))
	}
}

func validResponse(summary string) string {
	return `{"summary":"` + summary + `","hypotheses":[{"id":"contract_violation","cause":"The detector found a mismatch.","confidence":0.8,"evidence":["The bounded detector evidence reports a violation."],"counterEvidence":[]}]}`
}

func TestGenerateUsesOneCallForValidEnvelopeAndScrubsOutboundEvidence(t *testing.T) {
	client := &scriptedClient{responses: []string{validResponse("Review the deterministic mismatch.")}}
	secret := "sk-" + strings.Repeat("a", 24)
	result, aiErr := Generate(context.Background(), client, GenerateInput{Evidence: Evidence{
		Language: "es-CO", Message: "falló " + secret,
		Details:      []string{"uno", "dos", "tres", "cuatro", "cinco", "seis"},
		DetectorKind: "expression", Action: "quarantine",
	}})
	if aiErr != nil || len(result.Calls) != 1 || result.Repaired {
		t.Fatalf("valid response should take one call: %+v %v", result, aiErr)
	}
	if len(client.calls) != 1 || client.calls[0].MaxOutputUnits != MaxDiagnosisOutputUnits {
		t.Fatalf("call cap drifted: %+v", client.calls)
	}
	if strings.Contains(client.calls[0].Prompt, secret) || !strings.Contains(client.calls[0].Prompt, "[redacted]") ||
		!strings.Contains(client.calls[0].System, "Spanish") || strings.Contains(client.calls[0].Prompt, "seis") {
		t.Fatalf("outbound evidence was not scrubbed/bounded: %s\n%s", client.calls[0].System, client.calls[0].Prompt)
	}
}

func TestGenerateUsesExactlyOneExplicitRepairCall(t *testing.T) {
	client := &scriptedClient{responses: []string{
		`{"summary":"bad","actions":["approve"]}`,
		validResponse("Bounded repaired diagnosis."),
	}}
	result, aiErr := Generate(context.Background(), client, GenerateInput{Evidence: Evidence{
		Message: "detector mismatch", DetectorKind: "schema", Action: "observe",
	}})
	if aiErr != nil || len(client.calls) != 2 || !result.Repaired || len(result.Calls) != 2 {
		t.Fatalf("repair ladder: calls=%d result=%+v error=%v", len(client.calls), result, aiErr)
	}
	if !strings.Contains(client.calls[1].Prompt, "violated the required JSON envelope") {
		t.Fatalf("repair prompt missing bounded feedback: %s", client.calls[1].Prompt)
	}
}

func TestGenerateReadmitsBeforeRepairAndDoesNotReachProviderWhenDenied(t *testing.T) {
	client := &scriptedClient{responses: []string{
		`{"summary":"bad","actions":["approve"]}`,
		validResponse("This response must never be requested."),
	}}
	admissions := 0
	result, aiErr := Generate(context.Background(), client, GenerateInput{
		Evidence: Evidence{Message: "detector mismatch", DetectorKind: "schema", Action: "observe"},
		AdmitCall: func(context.Context) *ai.AIError {
			admissions++
			if admissions == 2 {
				return &ai.AIError{Class: "budget_blocked", Message: "monthly AI budget exceeded"}
			}
			return nil
		},
	})
	if aiErr == nil || aiErr.Class != "budget_blocked" || admissions != 2 || len(client.calls) != 1 || len(result.Calls) != 0 {
		t.Fatalf("repair must be re-admitted before egress: admissions=%d providerCalls=%d result=%+v err=%v",
			admissions, len(client.calls), result, aiErr)
	}
}

func TestGenerateFailsClosedAfterSecondInvalidEnvelope(t *testing.T) {
	client := &scriptedClient{responses: []string{`not json`, `{"summary":"still missing hypotheses"}`}}
	result, aiErr := Generate(context.Background(), client, GenerateInput{Evidence: Evidence{Message: "mismatch"}})
	if aiErr == nil || aiErr.Class != "invalid_output" || len(client.calls) != 2 || len(result.Calls) != 0 {
		t.Fatalf("invalid output must fail after two calls: %+v %v calls=%d", result, aiErr, len(client.calls))
	}
}

func TestGenerateRejectsOversizedOutputWithoutRepairCall(t *testing.T) {
	client := &scriptedClient{responses: []string{
		strings.Repeat(" ", MaxDiagnosisOutputBytes) + validResponse("oversized"),
		validResponse("must not be requested"),
	}}
	result, aiErr := Generate(context.Background(), client, GenerateInput{Evidence: Evidence{Message: "mismatch"}})
	if aiErr == nil || aiErr.Class != "invalid_output" || len(client.calls) != 1 || len(result.Calls) != 0 {
		t.Fatalf("oversized output must stop before repair: result=%+v err=%v calls=%d", result, aiErr, len(client.calls))
	}
}

func TestParseRejectsAuthorityUnknownFieldsAndBounds(t *testing.T) {
	for _, response := range []string{
		`{"summary":"x","hypotheses":[{"id":"h","cause":"c","confidence":0.5,"evidence":["e"],"counterEvidence":[]}],"candidate":{"kind":"accept_loss"}}`,
		`{"summary":"x","hypotheses":[]}`,
		`{"summary":"x","hypotheses":[{"id":"h","cause":"c","confidence":1.2,"evidence":["e"],"counterEvidence":[]}]}`,
		`{"summary":"x","hypotheses":[{"id":"UPPER ID","cause":"c","confidence":0.5,"evidence":["e"],"counterEvidence":[]}]}`,
	} {
		if parsed, err := Parse(response); err == nil {
			t.Fatalf("invalid envelope accepted: %+v", parsed)
		}
	}
	secret := "sk-" + strings.Repeat("b", 24)
	parsed, err := Parse(validResponse("saw " + secret))
	if err != nil || strings.Contains(parsed.Summary, secret) || !strings.Contains(parsed.Summary, "[redacted]") {
		t.Fatalf("provider output must be scrubbed: %+v %v", parsed, err)
	}
	if parsed, err := Parse(strings.Repeat(" ", MaxDiagnosisOutputBytes) + validResponse("too large")); err == nil {
		t.Fatalf("oversized envelope was parsed: %+v", parsed)
	}
}
