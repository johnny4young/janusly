//go:build integration

package httpapi

import (
	"encoding/base64"
	"testing"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/secretstore"
)

func TestHTTPAndLeafAuditsShareInjectedPolicy(t *testing.T) {
	policy, err := grammar.NewPersister(2)
	if err != nil {
		t.Fatal(err)
	}
	options := defaultV1ServerOptionsForTest()
	options.Audit = audit.NewWriter(policy)
	h := newAPIHarnessWithOptions(t, false, options)
	pool := testPool(t)
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "900000")
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	for _, tc := range []struct {
		path   string
		body   map[string]any
		status int
	}{
		{"/workflows/save", map[string]any{"id": "wf-policy-" + h.org, "name": "Policy test", "nodes": []any{map[string]any{"id": "one", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}, 200},
		{"/org/scim/directories", map[string]any{"providerDirectoryId": "directory-" + h.org, "defaultRole": "viewer"}, 200},
		{"/credentials", map[string]any{"name": "policy-signing", "kind": "external_runtime_signing_secret", "secretValue": "policy-secret"}, 200},
		{"/integrations/external-runtimes", map[string]any{"name": "Policy runtime", "runtimeKey": "policy.runtime", "signingCredentialName": "policy-signing"}, 201},
	} {
		response := h.call("POST", tc.path, tc.body, "")
		if response.status != tc.status {
			t.Fatalf("%s: status=%d body=%v", tc.path, response.status, response.body)
		}
	}
	for _, action := range []string{"workflow.saved", "org.scim.directory_attached", "external_runtime.connection.created"} {
		var raw string
		if err := pool.QueryRow(t.Context(), `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND action=$2 ORDER BY created_at DESC LIMIT 1`, h.org, action).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if raw != "{}" {
			t.Fatalf("%s bypassed injected cap: %s", action, raw)
		}
	}
}
