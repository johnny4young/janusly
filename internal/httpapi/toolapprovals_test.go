package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/auth"
)

// Automation and malformed decisions stop before the engine is consulted.
func TestToolApprovalDecisionRequiresAPerson(t *testing.T) {
	s := &V1Server{}
	valid := `{"approvalId":"a","paramsDigest":"d","decision":"approve"}`
	for name, test := range map[string]struct {
		body   string
		ctx    *auth.Context
		status int
	}{
		"service token":    {valid, &auth.Context{UserID: "svc", Mode: auth.ModeServiceToken}, http.StatusForbidden},
		"no identity":      {valid, &auth.Context{Mode: auth.ModeDevHeaders}, http.StatusForbidden},
		"unknown decision": {`{"approvalId":"a","paramsDigest":"d","decision":"skip"}`, &auth.Context{UserID: "bob"}, http.StatusBadRequest},
		"no digest":        {`{"approvalId":"a","decision":"approve"}`, &auth.Context{UserID: "bob"}, http.StatusBadRequest},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/runs/tool-approvals/decide", strings.NewReader(test.body))
			result := s.decideToolApprovalCore(r, v1Request{orgID: "org", authContext: test.ctx})
			if result.status != test.status {
				t.Fatalf("status %d, want %d", result.status, test.status)
			}
		})
	}
}
