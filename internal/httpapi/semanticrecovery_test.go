package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/engine"
)

func TestRecoveryMutationErrorDoesNotExposeInternalCause(t *testing.T) {
	secretCause := "query failed with evidence token sk-abcdefghijklmnopqrstuv"
	result := recoveryMutationError(errors.New(secretCause))
	if result.status != http.StatusInternalServerError || result.code != "internal_error" ||
		result.message != "Internal error" || strings.Contains(result.message, secretCause) {
		t.Fatalf("internal recovery error leaked through public envelope: %+v", result)
	}
}

func TestRecoveryCandidatesRequestPreservesWireIntent(t *testing.T) {
	decode := func(body string) (recoveryCandidatesBody, error) {
		request := httptest.NewRequest(http.MethodPost, "/v1/recovery/cases/case-1/candidates", strings.NewReader(body))
		return decodeRecoveryCandidatesRequest(request)
	}
	if body, err := decode(`{"expectedRevision":2}`); err != nil || body.ManualReplacement != nil || body.AcceptLossReason != "" {
		t.Fatalf("minimal candidates request rejected: body=%#v err=%v", body, err)
	}
	if body, err := decode(`{"expectedRevision":2,"manualReplacement":{"output":null,"reason":"Reviewed"}}`); err != nil ||
		body.ManualReplacement == nil || body.ManualReplacement.Output != nil {
		t.Fatalf("explicit null output must remain a supplied JSON value: body=%#v err=%v", body, err)
	}
	for _, raw := range []string{
		`{"expectedRevision":2,"manualReplacement":null}`,
		`{"expectedRevision":2,"manualReplacement":{"reason":"missing output"}}`,
		`{"expectedRevision":2,"manualReplacement":{"output":{},"reason":null}}`,
		`{"expectedRevision":2,"manualReplacement":{"output":{},"reason":"ok","patch":[]}}`,
		`{"expectedRevision":2,"acceptLossReason":null}`,
		`{"expectedRevision":2}{"expectedRevision":3}`,
	} {
		if body, err := decode(raw); err == nil {
			t.Fatalf("wire-invalid candidates request accepted: raw=%s body=%#v", raw, body)
		}
	}
}

func TestRecoveryMutationErrorExposesStableHumanApprovalGuard(t *testing.T) {
	result := recoveryMutationError(engine.ErrRecoveryHumanApprovalRequired)
	if result.status != http.StatusForbidden || result.code != "recovery_human_approval_required" ||
		result.message != "Recovery approval requires a human-authenticated session" {
		t.Fatalf("human approval guard envelope = %+v", result)
	}
}
