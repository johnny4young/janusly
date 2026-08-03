//go:build integration

package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// file_dropped: bucket+prefix+extension selector, etag-scoped dedupe.
// mcp_server_event: alias+resource+eventTypes selector, NO dedupe — every
// notification spawns its own run.
func TestFileAndMcpTriggerIngest(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())

	ingest := func(path string, payload map[string]any) (int, map[string]any) {
		res := h.call("POST", path, payload, "")
		if data, ok := res.body["data"].(map[string]any); ok {
			return res.status, data
		}
		if errBody, ok := res.body["error"].(map[string]any); ok {
			return res.status, errBody
		}
		return res.status, res.body
	}

	// ── file_dropped ────────────────────────────────────────────────────
	bucket := "exports-" + suffix
	fileWorkflow := map[string]any{
		"id": "wf-file-" + suffix, "name": "CSV drops", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "drop", "type": "file_dropped", "config": map[string]any{
				"bucket": bucket, "prefix": "incoming/", "extensions": []any{"csv"},
			}},
			map[string]any{"id": "shape", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{
					"object": "{{context.drop.output.event.key}}",
				}}},
		},
		"edges": []any{map[string]any{"from": "drop", "to": "shape"}},
	}
	if res := h.call("POST", "/v1/workflows/save", fileWorkflow, ""); res.status != 200 {
		t.Fatalf("save file wf: %+v", res.body)
	}

	fileEvent := map[string]any{
		"bucket": bucket, "key": "incoming/batch-1.csv", "sizeBytes": 1234,
		"etag": "v1", "eventName": "ObjectCreated:Put",
	}
	// Selector misses: wrong bucket, outside prefix, wrong extension.
	if status, _ := ingest("/v1/triggers/file/ingest", map[string]any{
		"bucket": "ghost", "key": "incoming/batch-1.csv"}); status != 404 {
		t.Fatalf("wrong bucket must 404: %d", status)
	}
	if status, _ := ingest("/v1/triggers/file/ingest", map[string]any{
		"bucket": bucket, "key": "outgoing/batch-1.csv"}); status != 404 {
		t.Fatalf("outside prefix must 404: %d", status)
	}
	if status, _ := ingest("/v1/triggers/file/ingest", map[string]any{
		"bucket": bucket, "key": "incoming/batch-1.pdf"}); status != 404 {
		t.Fatalf("wrong extension must 404: %d", status)
	}

	status, body := ingest("/v1/triggers/file/ingest", fileEvent)
	if status != 200 || body["ok"] != true {
		t.Fatalf("file ingest: %d %+v", status, body)
	}
	runID, _ := body["runId"].(string)
	h.waitRun(runID, "succeeded")
	var object string
	if err := pool.QueryRow(ctx,
		`SELECT state_json->'output'->>'object' FROM run_nodes WHERE run_id = $1 AND node_id = 'shape'`,
		runID).Scan(&object); err != nil || object != "incoming/batch-1.csv" {
		t.Fatalf("templated object key: %q %v", object, err)
	}

	// Same (bucket, key, etag) retry converges; a NEW etag re-fires.
	if status, body = ingest("/v1/triggers/file/ingest", fileEvent); status != 200 || body["duplicate"] != true {
		t.Fatalf("same etag must dedupe: %d %+v", status, body)
	}
	reupload := map[string]any{}
	for key, value := range fileEvent {
		reupload[key] = value
	}
	reupload["etag"] = "v2"
	if status, body = ingest("/v1/triggers/file/ingest", reupload); status != 200 || body["duplicate"] == true {
		t.Fatalf("new etag must re-fire: %d %+v", status, body)
	}

	// ── mcp_server_event ────────────────────────────────────────────────
	alias := "crm-" + suffix
	resource := "mcp://crm/accounts"
	mcpWorkflow := map[string]any{
		"id": "wf-mcp-" + suffix, "name": "CRM events", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "sub", "type": "mcp_server_event", "config": map[string]any{
				"connectionAlias": alias, "resourceUri": resource,
				"eventTypes": []any{"notifications/resources/updated"},
			}},
			map[string]any{"id": "shape", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{
					"kind": "{{context.sub.output.event.eventType}}",
				}}},
		},
		"edges": []any{map[string]any{"from": "sub", "to": "shape"}},
	}
	if res := h.call("POST", "/v1/workflows/save", mcpWorkflow, ""); res.status != 200 {
		t.Fatalf("save mcp wf: %+v", res.body)
	}

	mcpEvent := map[string]any{
		"connectionAlias": alias, "resourceUri": resource,
		"eventType": "notifications/resources/updated",
		"payload":   map[string]any{"accountId": "account-77"},
	}
	// The eventTypes filter rejects unlisted notification methods.
	if status, _ := ingest("/v1/triggers/mcp/ingest", map[string]any{
		"connectionAlias": alias, "resourceUri": resource,
		"eventType": "notifications/resources/deleted"}); status != 404 {
		t.Fatalf("filtered event type must 404: %d", status)
	}
	// Oversized resource payload is refused.
	if status, _ := ingest("/v1/triggers/mcp/ingest", map[string]any{
		"connectionAlias": alias, "resourceUri": resource,
		"eventType": "notifications/resources/updated",
		"payload":   map[string]any{"blob": strings.Repeat("x", 66_000)}}); status != 413 {
		t.Fatalf("oversized mcp payload must 413: %d", status)
	}

	// No dedupe: two identical notifications spawn two distinct runs.
	status, body = ingest("/v1/triggers/mcp/ingest", mcpEvent)
	if status != 200 || body["ok"] != true {
		t.Fatalf("mcp ingest: %d %+v", status, body)
	}
	firstRun, _ := body["runId"].(string)
	status, body = ingest("/v1/triggers/mcp/ingest", mcpEvent)
	if status != 200 || body["ok"] != true || body["duplicate"] == true {
		t.Fatalf("second notification must spawn its own run: %d %+v", status, body)
	}
	secondRun, _ := body["runId"].(string)
	if firstRun == secondRun || firstRun == "" {
		t.Fatalf("distinct runs expected: %q %q", firstRun, secondRun)
	}
	h.waitRun(firstRun, "succeeded")
	h.waitRun(secondRun, "succeeded")
}
