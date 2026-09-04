//go:build integration

package httpapi

import (
	"net/http"
	"testing"

	"github.com/johnny4young/janusly/internal/contract"
)

func manifestResponse(t *testing.T, method, path string) contract.Schema {
	t.Helper()
	for _, route := range contract.Routes {
		if route.Method == method && route.Path == path {
			return route.Response
		}
	}
	t.Fatalf("manifest has no %s %s", method, path)
	return nil
}

// The manifest is what the TypeScript client is generated from. These two
// endpoints were described as shapes the handlers never emitted; the served
// body must now satisfy the description key for key.
func TestDlqClustersAndRecoveryMetricsMatchManifest(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	for _, path := range []string{"/v1/dlq/clusters", "/v1/recovery/metrics"} {
		res := h.call("GET", path, nil, "")
		if res.status != http.StatusOK {
			t.Fatalf("%s: want 200, got %d: %v", path, res.status, res.body)
		}
		schema := manifestResponse(t, "GET", path)
		properties, _ := schema["properties"].(map[string]any)
		if properties == nil {
			t.Fatalf("%s: manifest response has no properties", path)
		}
		body := res.body
		if data, ok := body["data"].(map[string]any); ok {
			body = data
		}
		required, _ := schema["required"].([]string)
		for _, key := range required {
			if _, present := body[key]; !present {
				t.Fatalf("%s: response lacks required %q: %v", path, key, body)
			}
		}
		for key := range body {
			if _, described := properties[key]; !described {
				t.Fatalf("%s: response emits %q which the manifest does not describe", path, key)
			}
		}
	}
}
