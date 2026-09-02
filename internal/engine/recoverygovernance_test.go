package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func TestRecoveryApprovalRejectsServiceAndMCPPrincipalsBeforePersistence(t *testing.T) {
	for _, source := range []auth.Source{auth.SourceService, auth.SourceMcp} {
		t.Run(string(source), func(t *testing.T) {
			_, err := (&Engine{}).ApproveRecoveryCandidate(context.Background(), ApproveRecoveryCandidateInput{
				Auth: &auth.Context{
					OrgID: "org-1", UserID: "automation", Mode: auth.ModeServiceToken, Source: source,
				},
				CaseID: "case-1", ExpectedRevision: 3,
				CandidateArtifactID: "candidate-1", ValidationArtifactID: "validation-1",
			})
			if !errors.Is(err, ErrRecoveryHumanApprovalRequired) {
				t.Fatalf("ApproveRecoveryCandidate() error = %v, want human approval guard", err)
			}
		})
	}
}

func TestRecoveryActorKindPreservesHumanAndAgentProvenance(t *testing.T) {
	for _, test := range []struct {
		name   string
		actor  *auth.Context
		expect string
	}{
		{name: "nil defaults closed human", actor: nil, expect: "user"},
		{name: "web", actor: &auth.Context{Source: auth.SourceWeb}, expect: "user"},
		{name: "dev", actor: &auth.Context{Source: auth.SourceDev}, expect: "user"},
		{name: "mcp", actor: &auth.Context{Source: auth.SourceMcp}, expect: "agent"},
		{name: "service", actor: &auth.Context{Source: auth.SourceService}, expect: "agent"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := recoveryActorKind(test.actor); got != test.expect {
				t.Fatalf("actor kind = %q, want %q", got, test.expect)
			}
		})
	}
}

func TestCurrentRecoveryValidationRequiresExactTwoStepRevision(t *testing.T) {
	if !currentRecoveryValidation(7, 9) {
		t.Fatal("the exact two-step validation revision must remain current")
	}
	for _, stale := range []int64{0, 1, 6, 8, 9, 10} {
		if currentRecoveryValidation(stale, 9) {
			t.Fatalf("validation revision %d must be stale for case revision 9", stale)
		}
	}
}

func TestBoundedRecoveryArtifactScrubsKeysAndSecretShapes(t *testing.T) {
	raw, digest, err := boundedRecoveryArtifact(map[string]any{
		"apiKey": "literal-value",
		"note":   "provider returned sk-abcdefghijklmnopqrstuv in evidence",
		"nested": []any{map[string]any{"authorization": "Bearer clear"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, forbidden := range []string{"literal-value", "sk-abcdefghijklmnopqrstuv", "Bearer clear"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("artifact leaked %q: %s", forbidden, text)
		}
	}
	if strings.Count(text, "[redacted]") < 3 || len(digest) != 64 {
		t.Fatalf("artifact redaction/digest missing: %s %q", text, digest)
	}
}

func TestParseSemanticRecoveryCandidateAllowsOnlyBoundedManualFollowUp(t *testing.T) {
	candidate := SemanticRecoveryCandidatePayload{
		Kind: "adjust_detector", Decision: "manual_follow_up",
		Target: &SemanticRecoveryCandidateTarget{
			WorkflowID: "workflow", WorkflowVersionID: "version", DetectorID: "detector",
		},
		Reason: "Review the detector", Risk: "high",
		Evidence:            []domain.RecoveryCaseEvidenceRef{{Kind: "semantic_detector", ID: "detector"}},
		ExpectedResult:      "A qualified successor version",
		RequiredPermissions: []string{"recovery.write", "workflows.write"},
	}
	raw, _ := json.Marshal(candidate)
	if _, err := ParseSemanticRecoveryCandidatePayload(raw); err != nil {
		t.Fatalf("typed follow-up rejected: %v", err)
	}
	for name, malformed := range map[string]json.RawMessage{
		"unknown top level": append(append(json.RawMessage{}, raw[:len(raw)-1]...), []byte(`,"patch":{"arbitrary":true}}`)...),
		"unknown target":    json.RawMessage(strings.Replace(string(raw), `"detectorId":"detector"`, `"detectorId":"detector","patch":{}`, 1)),
		"unknown evidence":  json.RawMessage(strings.Replace(string(raw), `"id":"detector"`, `"id":"detector","secret":"hidden"`, 1)),
		"invalid evidence hash": json.RawMessage(strings.Replace(
			string(raw), `"id":"detector"`, `"id":"detector","sha256":"`+strings.Repeat("A", 64)+`"`, 1,
		)),
		"second document": append(append(json.RawMessage{}, raw...), []byte(` {}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseSemanticRecoveryCandidatePayload(malformed); err == nil {
				t.Fatal("candidate payload accepted contract drift")
			}
		})
	}
	candidate.RequiredPermissions = []string{"recovery.write"}
	raw, _ = json.Marshal(candidate)
	if _, err := ParseSemanticRecoveryCandidatePayload(raw); err == nil {
		t.Fatal("workflow follow-up without workflows.write must fail closed")
	}
	candidate.RequiredPermissions = []string{"recovery.write", "workflows.write"}
	candidate.Output = map[string]any{"patch": "arbitrary"}
	raw, _ = json.Marshal(candidate)
	if _, err := ParseSemanticRecoveryCandidatePayload(raw); err == nil {
		t.Fatal("manual follow-up must never carry arbitrary patch/output JSON")
	}
}

func TestParseSemanticRecoveryValidationRequiresExactEnvelope(t *testing.T) {
	validation := SemanticRecoveryValidationPayload{
		CandidateArtifactID: "candidate-1",
		CandidateSha256:     strings.Repeat("a", 64),
		CaseRevision:        4,
		Passed:              false,
		Summary:             "Candidate remains blocked",
	}
	raw, _ := json.Marshal(validation)
	if parsed, err := ParseSemanticRecoveryValidationPayload(raw); err != nil || parsed.Passed {
		t.Fatalf("exact failed validation rejected: %+v %v", parsed, err)
	}
	encode := func(value any) json.RawMessage {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	for name, malformed := range map[string]json.RawMessage{
		"unknown field": append(append(json.RawMessage{}, raw[:len(raw)-1]...), []byte(`,"debug":true}`)...),
		"missing passed": encode(map[string]any{
			"candidateArtifactId": validation.CandidateArtifactID,
			"candidateSha256":     validation.CandidateSha256,
			"caseRevision":        validation.CaseRevision,
			"summary":             validation.Summary,
		}),
		"uppercase hash": encode(map[string]any{
			"candidateArtifactId": validation.CandidateArtifactID,
			"candidateSha256":     strings.Repeat("A", 64),
			"caseRevision":        validation.CaseRevision,
			"passed":              true,
			"summary":             validation.Summary,
		}),
		"oversized candidate id": encode(map[string]any{
			"candidateArtifactId": strings.Repeat("c", 257),
			"candidateSha256":     validation.CandidateSha256,
			"caseRevision":        validation.CaseRevision,
			"passed":              true,
			"summary":             validation.Summary,
		}),
		"empty summary": encode(map[string]any{
			"candidateArtifactId": validation.CandidateArtifactID,
			"candidateSha256":     validation.CandidateSha256,
			"caseRevision":        validation.CaseRevision,
			"passed":              true,
			"summary":             " ",
		}),
		"second document": append(append(json.RawMessage{}, raw...), []byte(` {}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseSemanticRecoveryValidationPayload(malformed); err == nil {
				t.Fatal("validation payload accepted contract drift")
			}
		})
	}
}

func TestBuildRecoveryCandidateArtifactsRejectsReplacementForObserveCase(t *testing.T) {
	_, err := buildRecoveryCandidateArtifacts(store.RecoveryCase{
		ID: "case-observe", RunID: "run-1", SourceNodeID: "result",
		DetectorID: "detector-1", Action: "observe",
	}, CreateRecoveryCandidatesInput{ManualReplacement: &SemanticManualReplacement{
		Output: map[string]any{"verified": true}, Reason: "override completed evidence",
	}})
	if !errors.Is(err, ErrRecoverySemanticInputInvalid) {
		t.Fatalf("observe replacement error = %v, want invalid input", err)
	}
}

func TestBoundedRecoveryArtifactRejectsTruncationSentinel(t *testing.T) {
	_, _, err := boundedRecoveryArtifact(map[string]any{"blob": strings.Repeat("x", recoveryArtifactMaxBytes+1_000)})
	if err != ErrRecoveryArtifactTooLarge {
		t.Fatalf("expected explicit too-large error, got %v", err)
	}
}
