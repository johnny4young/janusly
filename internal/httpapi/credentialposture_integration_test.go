//go:build integration

package httpapi

import (
	"testing"

	"github.com/johnny4young/janusly/internal/secretstore"
)

func TestCredentialStoreUnconfiguredPosture(t *testing.T) {
	h := newAPIHarness(t)
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY", "")
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "")

	res := h.call("POST", "/credentials", map[string]any{
		"name": "first-connection", "kind": "github_token", "secretValue": "ghp-example",
	}, "")
	if res.status != 500 || res.body["code"] != "credentials_secret_store_unavailable" {
		t.Fatalf("managed write without a root key must fail closed: %d %+v", res.status, res.body)
	}

	var persisted int
	if err := testPool(t).QueryRow(t.Context(),
		`SELECT count(*) FROM credentials WHERE org_id = $1 AND name = 'first-connection'`, h.org,
	).Scan(&persisted); err != nil || persisted != 0 {
		t.Fatalf("refused write must persist nothing: count=%d err=%v", persisted, err)
	}

	res = h.call("GET", "/credentials/health", nil, "")
	if res.status != 200 || res.body["managedStorageAvailable"] != false {
		t.Fatalf("health must expose a safe degraded posture: %d %+v", res.status, res.body)
	}
}
