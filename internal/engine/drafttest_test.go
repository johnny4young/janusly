package engine

import "testing"

func TestDraftTestOutputOnlyInValidationRuns(t *testing.T) {
	envelope := []byte(`{"workflow":{},"input":{},"draftTest":{"pins":{"fetch":{"kind":"mocked","output":{"v":1}},"gate":{"kind":"mocked","output":{}}}}}`)
	cases := []struct {
		name, mode, node, nodeType string
		input                      []byte
		want                       bool
	}{
		{"validation run", "validation", "fetch", "http", envelope, true},
		{"production run", "", "fetch", "http", envelope, false},
		{"other replay mode", "replay", "fetch", "http", envelope, false},
		{"step without a pin", "validation", "shape", "transform", envelope, false},
		{"approval", "validation", "gate", "approval", envelope, false},
		{"no envelope", "validation", "fetch", "http", []byte(`{"input":{"draftTest":{"pins":{"fetch":{"output":1}}}}}`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, got := draftTestOutput(tc.mode, tc.input, tc.node, tc.nodeType); got != tc.want {
				t.Fatalf("draftTestOutput = %v, want %v", got, tc.want)
			}
		})
	}
}
