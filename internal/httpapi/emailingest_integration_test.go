//go:build integration

package httpapi

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func emailWorkflow(wfID, aliasKey string, extraConfig map[string]any) map[string]any {
	config := map[string]any{"aliasKey": aliasKey}
	for key, value := range extraConfig {
		config[key] = value
	}
	return map[string]any{
		"id": wfID, "name": "Email " + aliasKey, "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "inbox", "type": "email_received", "config": config},
			map[string]any{"id": "shape", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{
					"subject": "{{context.inbox.output.event.subject}}",
					"from":    "{{context.inbox.output.event.from}}",
				}}},
		},
		"edges": []any{map[string]any{"from": "inbox", "to": "shape"}},
	}
}

// The normalized email seam: DKIM gate (opt-out), sender-domain
// allow-list, the authoritative 1 MiB body cap, attachment offload to the
// object store (traversal-safe keys, oversize dropped), and messageId
// idempotency that never re-uploads on a relay retry.
func TestEmailIngestSeam(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	objectRoot := t.TempDir()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", objectRoot)

	alias := "invoices-" + suffix
	wfID := "wf-email-" + suffix
	if res := h.call("POST", "/v1/workflows/save", emailWorkflow(wfID, alias, nil), ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	// send unwraps the versioned envelope: success → data, error → the
	// error object (so callers read code/ok/duplicate uniformly).
	send := func(overrides map[string]any) (int, map[string]any) {
		payload := map[string]any{
			"aliasKey": alias, "from": "billing@partner.example",
			"subject": "Invoice INV-9", "body": "total: 99.50", "dkimPass": true,
		}
		for key, value := range overrides {
			payload[key] = value
		}
		res := h.call("POST", "/v1/triggers/email/ingest", payload, "")
		if data, ok := res.body["data"].(map[string]any); ok {
			return res.status, data
		}
		if errBody, ok := res.body["error"].(map[string]any); ok {
			return res.status, errBody
		}
		return res.status, res.body
	}

	// DKIM gate: default-required rejects an unverified sender.
	if status, body := send(map[string]any{"dkimPass": false}); status != 403 || body["code"] != "trigger_dkim_required" {
		t.Fatalf("dkim gate: %d %+v", status, body)
	}
	// Unknown alias is an opaque 404.
	if status, _ := send(map[string]any{"aliasKey": "ghost-" + suffix}); status != 404 {
		t.Fatalf("unknown alias must 404: %d", status)
	}
	// Authoritative body byte cap.
	if status, _ := send(map[string]any{"body": strings.Repeat("x", 1_048_577)}); status != 413 {
		t.Fatalf("oversized body must 413: %d", status)
	}

	// The happy path spawns a run whose transform sees the envelope.
	status, body := send(map[string]any{
		"messageId": "msg-1-" + suffix,
		"attachments": []any{
			map[string]any{"filename": "../../evil report.pdf", "contentType": "application/pdf"},
			map[string]any{"filename": "big.bin"},
		},
		"attachmentBodies": map[string]any{
			"../../evil report.pdf": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake")),
			"big.bin":               base64.StdEncoding.EncodeToString(make([]byte, 1_048_577)),
		},
	})
	if status != 200 || body["ok"] != true {
		t.Fatalf("ingest: %d %+v", status, body)
	}
	runID, _ := body["runId"].(string)
	triggerEventID, _ := body["triggerEventId"].(string)
	h.waitRun(runID, "succeeded")
	var subject string
	if err := pool.QueryRow(ctx,
		`SELECT state_json->'output'->>'subject' FROM run_nodes WHERE run_id = $1 AND node_id = 'shape'`,
		runID).Scan(&subject); err != nil || subject != "Invoice INV-9" {
		t.Fatalf("templated subject: %q %v", subject, err)
	}

	// Attachment truth: sanitized name stored under the org prefix, the
	// oversized one dropped, and no traversal escape on disk.
	var payloadJSON string
	_ = pool.QueryRow(ctx, `SELECT payload_json::text FROM trigger_events WHERE id = $1`, triggerEventID).Scan(&payloadJSON)
	if !strings.Contains(payloadJSON, `"stored": true`) || !strings.Contains(payloadJSON, "0-__evil_report.pdf") {
		t.Fatalf("stored attachment metadata missing: %s", payloadJSON)
	}
	if !strings.Contains(payloadJSON, `"stored": false`) {
		t.Fatalf("oversized attachment must be dropped: %s", payloadJSON)
	}
	if strings.Contains(payloadJSON, "%PDF") {
		t.Fatalf("attachment BODY must never persist in trigger_events")
	}
	orgDir := filepath.Join(objectRoot, "orgs", h.org, "email")
	entries, err := os.ReadDir(orgDir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("attachments must land under the org prefix: %v %d", err, len(entries))
	}
	if _, err := os.Stat(filepath.Join(objectRoot, "evil report.pdf")); !os.IsNotExist(err) {
		t.Fatal("traversal filename must not escape the org prefix")
	}
	uploaded, _ := os.ReadDir(filepath.Join(orgDir, entries[0].Name()))
	if len(uploaded) != 1 {
		t.Fatalf("exactly the capped attachment set uploads: %d", len(uploaded))
	}

	// Relay retry with the same messageId converges WITHOUT re-uploading.
	status, body = send(map[string]any{
		"messageId": "msg-1-" + suffix,
		"attachments": []any{
			map[string]any{"filename": "again.pdf"},
		},
		"attachmentBodies": map[string]any{"again.pdf": base64.StdEncoding.EncodeToString([]byte("dup"))},
	})
	if status != 200 || body["duplicate"] != true {
		t.Fatalf("retry must dedupe: %d %+v", status, body)
	}
	if retried, _ := os.ReadDir(filepath.Join(orgDir, entries[0].Name())); len(retried) != 1 {
		t.Fatalf("retry must not re-upload attachments: %d", len(retried))
	}

	// Sender-domain allow-list on a second alias.
	strictAlias := "strict-" + suffix
	strictWfID := "wf-email-strict-" + suffix
	if res := h.call("POST", "/v1/workflows/save", emailWorkflow(strictWfID, strictAlias, map[string]any{
		"fromDomains": []any{"trusted.example"},
	}), ""); res.status != 200 {
		t.Fatalf("save strict: %+v", res.body)
	}
	if status, _ := send(map[string]any{"aliasKey": strictAlias}); status != 403 {
		t.Fatalf("unlisted sender domain must 403: %d", status)
	}
	if status, body := send(map[string]any{"aliasKey": strictAlias, "from": "ap@trusted.example"}); status != 200 || body["ok"] != true {
		t.Fatalf("allow-listed sender: %d %+v", status, body)
	}

	// A second workflow claiming the SAME alias makes the selector 409.
	if res := h.call("POST", "/v1/workflows/save", emailWorkflow("wf-email-dup-"+suffix, alias, nil), ""); res.status != 200 {
		t.Fatalf("save dup: %+v", res.body)
	}
	if status, body := send(map[string]any{"messageId": "msg-2-" + suffix}); status != 409 ||
		body["code"] != "trigger_selector_ambiguous" {
		t.Fatalf("ambiguous alias must 409: %d %+v", status, body)
	}
}
