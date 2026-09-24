//go:build integration

package httpapi

import (
	"net/http"
	"reflect"
	"testing"
	"time"
)

func TestDLQContractEntryAliasesAndResolution(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	id := "letter-" + h.org
	seedQueueDeadLetter(t, h.org, id, "open", "failure", time.Now().UTC().Truncate(time.Millisecond))
	seedQueueRecoveryItem(t, h.org, "item-"+h.org, id, "p1", "", time.Now().UTC())
	const entry = "/v1/dlq/entries/{deadLetterId}"
	list := h.call("GET", "/v1/dlq", nil, "")
	requireEnvelope(t, list)
	requireManifestData(t, "/v1/dlq", list.body["data"])
	empty := h.call("GET", "/v1/dlq?status=resolved", nil, "")
	requireManifestData(t, "/v1/dlq", empty.body["data"])
	if len(empty.body["data"].([]any)) != 0 {
		t.Fatal("expected empty resolved list")
	}
	var prior map[string]any
	for _, path := range []string{"/dlq?id=" + id, "/dlq/entries/" + id, "/v1/dlq/entries/" + id} {
		response := h.call("GET", path, nil, "")
		if response.status != http.StatusOK {
			t.Fatalf("%s: %d %v", path, response.status, response.body)
		}
		data := response.body
		if wrapped, ok := data["data"].(map[string]any); ok {
			data = wrapped
		}
		requireManifestData(t, entry, data)
		if prior != nil && !reflect.DeepEqual(prior, data) {
			t.Fatalf("aliases differ: %s", path)
		}
		prior = data
		denied := h.call("GET", path, nil, h.org+"-foreign")
		if denied.status != http.StatusNotFound {
			t.Fatalf("foreign entry: %d %v", denied.status, denied.body)
		}
	}
	seedMemberRow(t, testPool(t), h.org, "reader-"+h.org, "reader@example.test", "viewer")
	for _, path := range []string{"/dlq/resolve", "/v1/dlq/resolve"} {
		denied := h.callWithHeaders("POST", path, map[string]any{"id": id}, "", map[string]string{"x-user-id": "reader-" + h.org})
		if denied.status != http.StatusForbidden {
			t.Fatalf("viewer resolve: %d %v", denied.status, denied.body)
		}
		for _, missingID := range []string{"missing-" + h.org, id} {
			org := ""
			if missingID == id {
				org = h.org + "-foreign"
			}
			missing := h.call("POST", path, map[string]any{"id": missingID}, org)
			if missing.status != http.StatusNotFound {
				t.Fatalf("non-owned resolve must not claim success: %d %v", missing.status, missing.body)
			}
		}
		invalid := h.call("POST", path, map[string]any{}, "")
		if invalid.status != http.StatusBadRequest {
			t.Fatalf("invalid resolve: %v", invalid.body)
		}
	}
	var receipts int
	if err := testPool(t).QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE action = 'dlq.resolved' AND target_id = $1`, id).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Fatal("denied or missing row emitted success audit")
	}
	resolved := h.call("POST", "/v1/dlq/resolve", map[string]any{"id": id}, "")
	requireEnvelope(t, resolved)
	if resolved.status != http.StatusOK || resolved.body["data"].(map[string]any)["ok"] != true {
		t.Fatalf("resolve: %v", resolved.body)
	}
	if err := resolvedManifestSchema(t, "POST", "/v1/dlq/resolve").Validate(resolved.body["data"]); err != nil {
		t.Fatal(err)
	}
	var status, reason string
	if err := testPool(t).QueryRow(t.Context(), `SELECT status, resolution_reason FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`, h.org, id).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "resolved" || reason != "accepted_loss" {
		t.Fatalf("resolution must remain honest: %s %s", status, reason)
	}
	legacy := h.call("POST", "/dlq/resolve", map[string]any{"id": id}, "")
	if legacy.status != http.StatusOK || legacy.body["ok"] != true || legacy.body["apiVersion"] != nil {
		t.Fatalf("legacy receipt: %v", legacy.body)
	}
}
