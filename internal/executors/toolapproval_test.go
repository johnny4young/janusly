package executors

import (
	"context"
	"testing"
)

// A listed tool runs only as the tool step that was approved; a loop or an
// agent that reaches it gets a refusal, and validation still skips the write.
func TestListedToolRunsOnlyAsTheApprovedStep(t *testing.T) {
	registry := NewToolRegistry()
	listed := func(name string) bool { return name == "text.uppercase" || name == "webhook.send" }
	call := func(name string, input map[string]any, in Input) map[string]any {
		in.ApprovalRequired = listed
		return executeRegisteredTool(context.Background(), registry, nil, name, input, in)
	}
	if got := call("text.uppercase", map[string]any{"value": "a"}, Input{}); got["code"] != "TOOL_APPROVAL_REQUIRED" {
		t.Fatalf("an unapproved listed call ran: %v", got)
	}
	if got := call("text.uppercase", map[string]any{"value": "a"}, Input{ApprovedTool: "text.uppercase"}); got["ok"] != true || got["value"] != "A" {
		t.Fatalf("the approved call did not run: %v", got)
	}
	if got := call("text.uppercase", map[string]any{"value": "a"}, Input{ApprovedTool: "json.parse"}); got["code"] != "TOOL_APPROVAL_REQUIRED" {
		t.Fatalf("an approval for another tool was reused: %v", got)
	}
	write := map[string]any{"credential": "hook", "url": "https://hooks.example.test/x", "payload": map[string]any{}}
	if got := call("webhook.send", write, Input{DryRun: true}); got["skipped"] != true {
		t.Fatalf("validation must keep skipping a listed write: %v", got)
	}
}
