package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

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

func TestBoundedRecoveryArtifactRejectsTruncationSentinel(t *testing.T) {
	_, _, err := boundedRecoveryArtifact(map[string]any{"blob": strings.Repeat("x", recoveryArtifactMaxBytes+1_000)})
	if err != ErrRecoveryArtifactTooLarge {
		t.Fatalf("expected explicit too-large error, got %v", err)
	}
}
