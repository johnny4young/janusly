package config

import (
	"strings"
	"testing"
)

func TestHTTPBootValidationUsesCatalog(t *testing.T) {
	for _, mode := range []string{"development", "production"} {
		t.Run(mode, func(t *testing.T) {
			values := map[string]string{"JANUSLY_ENV": mode, "JANUSLY_HTTP_TIMEOUT_MS": "1", "JANUSLY_HTTP_MAX_RESPONSE_BYTES": "1", "JANUSLY_HTTP_MAX_REDIRECTS": "0", "JANUSLY_HTTP_STREAM_PREVIEW_BYTES": "1024"}
			if _, err := Load(env(values)); err != nil {
				t.Fatalf("canonical minimums rejected: %v", err)
			}
			for key := range values {
				if key != "JANUSLY_ENV" {
					values[key] = "SENSITIVE-VALUE"
				}
			}
			_, err := Load(env(values))
			if err == nil || strings.Contains(err.Error(), "SENSITIVE") {
				t.Fatalf("unsafe/no rejection: %v", err)
			}
			for key := range values {
				if key != "JANUSLY_ENV" && !strings.Contains(err.Error(), key) {
					t.Fatalf("missing aggregated key: %s", key)
				}
			}
		})
	}
}
