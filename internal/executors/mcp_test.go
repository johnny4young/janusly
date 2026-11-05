package executors

import (
	"context"
	"errors"
	"testing"
)

func TestMcpToolFailureCarriesWriteSide(t *testing.T) {
	cases := []struct {
		name      string
		writeSide bool
	}{
		{"read-side stays retryable", false},
		{"write-side stops whole-node retries", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewMcpToolExecutor()(context.Background(), Input{
				Config: map[string]any{"connectionAlias": "crm", "toolName": "update"},
				Mcp: &McpDeps{Execute: func(context.Context, McpCall) McpEnvelope {
					return McpEnvelope{Error: "dial tcp 10.0.0.1:443: connect: connection refused", WriteSide: tc.writeSide}
				}},
			})
			var shape *ExecErrorShape
			if !errors.As(err, &shape) {
				t.Fatalf("got %v, want ExecErrorShape", err)
			}
			if shape.WriteSide != tc.writeSide {
				t.Fatalf("WriteSide = %v, want %v", shape.WriteSide, tc.writeSide)
			}
			if want := "mcp_tool failed: dial tcp 10.0.0.1:443: connect: connection refused"; shape.Message != want {
				t.Fatalf("message = %q, want %q", shape.Message, want)
			}
		})
	}
}
