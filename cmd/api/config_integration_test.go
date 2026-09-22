//go:build integration

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExecutableRejectsInvalidConfigurationBeforeDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	for _, target := range []struct{ name, path string }{{"api", "."}, {"mcp", "../mcp"}} {
		binary := filepath.Join(t.TempDir(), target.name)
		if out, err := exec.CommandContext(ctx, "go", "build", "-o", binary, target.path).CombinedOutput(); err != nil {
			t.Fatalf("build: %v\n%s", err, out)
		}
		for _, environment := range []string{"development", "production"} {
			for _, key := range []string{"JANUSLY_PERSIST_MAX_BYTES", "JANUSLY_HTTP_TIMEOUT_MS", "JANUSLY_HTTP_MAX_RESPONSE_BYTES", "JANUSLY_HTTP_MAX_REDIRECTS", "JANUSLY_HTTP_STREAM_PREVIEW_BYTES", "JANUSLY_DB_TOOL_MAX_PROCESS_POOLS", "JANUSLY_PORT", "JANUSLY_INTERNAL_HOST", "JANUSLY_REAPER_INTERVAL_MS", "JANUSLY_REAPER_THRESHOLD_MS", "JANUSLY_REAPER_THRESHOLD_FLOOR_MS", "JANUSLY_STALLED_NODE_THRESHOLD_MINUTES"} {
				t.Run(target.name+"/"+environment+"/"+key, func(t *testing.T) {
					childCtx, stop := context.WithTimeout(ctx, 5*time.Second)
					defer stop()
					child := exec.CommandContext(childCtx, binary)
					child.Env = []string{"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=" + environment, "JANUSLY_DATABASE_URL=postgres://DB-SECRET@127.0.0.1:1/unreachable", key + "=VALUE-SECRET-DO-NOT-LOG"}
					output, err := child.CombinedOutput()
					if err == nil || childCtx.Err() != nil {
						t.Fatalf("expected immediate configuration rejection: %v %s", err, output)
					}
					message := string(output)
					if !strings.Contains(message, "invalid configuration") || !strings.Contains(message, key) || strings.Contains(message, "SECRET") || strings.Contains(message, "unreachable") {
						t.Fatalf("expected redacted boot error before database/provenance: %s", message)
					}
				})
			}
		}
	}
}
