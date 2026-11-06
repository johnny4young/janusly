//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
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

func closeReceipts(t *testing.T, org, id string) []map[string]any {
	t.Helper()
	rows, err := testPool(t).Query(t.Context(), `SELECT metadata FROM audit_logs
		WHERE org_id = $1 AND action = 'dlq.resolved' AND target_id = $2 ORDER BY created_at`, org, id)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	receipts := []map[string]any{}
	for rows.Next() {
		var raw []byte
		var metadata map[string]any
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &metadata); err != nil {
			t.Fatal(err)
		}
		receipts = append(receipts, metadata)
	}
	return receipts
}

func deadLetterStatus(t *testing.T, id string) string {
	t.Helper()
	var status string
	if err := testPool(t).QueryRow(t.Context(), `SELECT status FROM dead_letters WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestDLQCloseReasonIsAuditedAndBounded(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	seed := func(name string) string {
		id := name + "-" + h.org
		seedQueueDeadLetter(t, h.org, id, "open", "failure", now)
		return id
	}
	const secret = "Refunded by hand to <b>ACME</b>"

	t.Run("a rejected reason closes nothing and is not echoed", func(t *testing.T) {
		id := seed("invalid")
		long := secret + strings.Repeat("x", closeReasonMaxRunes)
		for _, reason := range []any{long, "   ", secret + "\x00", 7} {
			for _, call := range []struct {
				path string
				body map[string]any
			}{
				{"/v1/dlq/resolve", map[string]any{"id": id, "reason": reason}},
				{"/dlq/resolve", map[string]any{"id": id, "reason": reason}},
				{"/dlq/bulk-resolve", map[string]any{"deadLetterIds": []any{id}, "reason": reason}},
			} {
				res := h.call("POST", call.path, call.body, "")
				if res.status != http.StatusBadRequest {
					t.Fatalf("%s %v: %d %v", call.path, reason, res.status, res.body)
				}
				raw, _ := json.Marshal(res.body)
				if !strings.Contains(string(raw), "dlq_reason_invalid") || strings.Contains(string(raw), "ACME") {
					t.Fatalf("%s: %s", call.path, raw)
				}
			}
		}
		if status := deadLetterStatus(t, id); status != "open" {
			t.Fatalf("status %s", status)
		}
		if receipts := closeReceipts(t, h.org, id); len(receipts) != 0 {
			t.Fatalf("receipts %v", receipts)
		}
	})

	t.Run("the trimmed reason lands only on the audit row", func(t *testing.T) {
		id := seed("reason")
		seedQueueRecoveryItem(t, h.org, "item-reason-"+h.org, id, "p1", "", now)
		res := h.call("POST", "/v1/dlq/resolve", map[string]any{"id": id, "reason": "  " + secret + "\n"}, "")
		if res.status != http.StatusOK {
			t.Fatalf("%d %v", res.status, res.body)
		}
		receipts := closeReceipts(t, h.org, id)
		if len(receipts) != 1 || receipts[0]["reason"] != secret {
			t.Fatalf("receipts %v", receipts)
		}
		raw, _ := json.Marshal(res.body)
		if strings.Contains(string(raw), "ACME") {
			t.Fatalf("response echoes the reason: %s", raw)
		}
		var resolution string
		if err := testPool(t).QueryRow(t.Context(), `SELECT resolution_reason FROM recovery_items
			WHERE org_id = $1 AND dead_letter_id = $2`, h.org, id).Scan(&resolution); err != nil {
			t.Fatal(err)
		}
		if resolution != "accepted_loss" {
			t.Fatalf("resolution_reason %q", resolution)
		}
		read := func(org string) string {
			page := h.call("GET", "/audit?action=dlq.resolved", nil, org)
			if page.status != http.StatusOK {
				t.Fatalf("audit read for %s: %d %v", org, page.status, page.body)
			}
			raw, _ := json.Marshal(page.body)
			return string(raw)
		}
		if !strings.Contains(read(h.org), "ACME") {
			t.Fatal("the owning organization cannot read its reason")
		}
		if strings.Contains(read(h.org+"-foreign"), "ACME") {
			t.Fatal("another organization reads the reason")
		}
		seedMemberRow(t, testPool(t), h.org, "reader-"+h.org, "reader@example.test", "viewer")
		if denied := h.callWithHeaders("GET", "/audit", nil, "", map[string]string{"x-user-id": "reader-" + h.org}); denied.status != http.StatusForbidden {
			t.Fatalf("viewer audit read: %d %v", denied.status, denied.body)
		}
	})

	t.Run("clients that send only an id keep working without a reason", func(t *testing.T) {
		id := seed("legacy")
		res := h.call("POST", "/dlq/resolve", map[string]any{"id": id}, "")
		if res.status != http.StatusOK || res.body["ok"] != true {
			t.Fatalf("%d %v", res.status, res.body)
		}
		receipts := closeReceipts(t, h.org, id)
		if len(receipts) != 1 {
			t.Fatalf("receipts %v", receipts)
		}
		if _, present := receipts[0]["reason"]; present {
			t.Fatalf("invented a reason: %v", receipts[0])
		}
	})

	t.Run("another organization gets no closure and no receipt", func(t *testing.T) {
		id := seed("foreign")
		foreign := h.org + "-foreign"
		res := h.call("POST", "/v1/dlq/resolve", map[string]any{"id": id, "reason": secret}, foreign)
		if res.status != http.StatusNotFound {
			t.Fatalf("%d %v", res.status, res.body)
		}
		bulk := h.call("POST", "/dlq/bulk-resolve", map[string]any{"deadLetterIds": []any{id}, "reason": secret}, foreign)
		if bulk.body["resolved"] != float64(0) || bulk.body["failed"] != float64(1) {
			t.Fatalf("%v", bulk.body)
		}
		if deadLetterStatus(t, id) != "open" || len(closeReceipts(t, h.org, id))+len(closeReceipts(t, foreign, id)) != 0 {
			t.Fatal("foreign close left a mark")
		}
	})

	t.Run("bulk writes the shared reason per closed row", func(t *testing.T) {
		first, second := seed("bulk-a"), seed("bulk-b")
		res := h.call("POST", "/dlq/bulk-resolve", map[string]any{
			"deadLetterIds": []any{first, second, "missing-" + h.org}, "reason": secret,
		}, "")
		if res.body["resolved"] != float64(2) || res.body["failed"] != float64(1) {
			t.Fatalf("%v", res.body)
		}
		for _, id := range []string{first, second} {
			receipts := closeReceipts(t, h.org, id)
			if len(receipts) != 1 || receipts[0]["reason"] != secret || receipts[0]["bulk"] != true {
				t.Fatalf("%s receipts %v", id, receipts)
			}
		}
	})

	t.Run("a failed receipt rolls the closure back", func(t *testing.T) {
		single, bulk := seed("atomic-a"), seed("atomic-b")
		pool := testPool(t)
		const fn = "reject_close_receipt_test"
		statement := `CREATE OR REPLACE FUNCTION ` + fn + `() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'receipt refused'; END $$`
		if _, err := pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DROP FUNCTION `+fn+` CASCADE`)
		})
		// The literal org keeps concurrent suites in this database unaffected.
		trigger := `CREATE OR REPLACE TRIGGER ` + fn + ` BEFORE INSERT ON audit_logs FOR EACH ROW
			WHEN (NEW.org_id = '` + h.org + `' AND NEW.action = 'dlq.resolved') EXECUTE FUNCTION ` + fn + `()`
		if _, err := pool.Exec(t.Context(), trigger); err != nil {
			t.Fatal(err)
		}
		res := h.call("POST", "/v1/dlq/resolve", map[string]any{"id": single, "reason": secret}, "")
		if res.status != http.StatusInternalServerError {
			t.Fatalf("%d %v", res.status, res.body)
		}
		raw, _ := json.Marshal(res.body)
		if strings.Contains(string(raw), "ACME") || strings.Contains(string(raw), "receipt refused") {
			t.Fatalf("error leaks detail: %s", raw)
		}
		if res := h.call("POST", "/dlq/bulk-resolve", map[string]any{"deadLetterIds": []any{bulk}, "reason": secret}, ""); res.status != http.StatusInternalServerError {
			t.Fatalf("%d %v", res.status, res.body)
		}
		for _, id := range []string{single, bulk} {
			if status := deadLetterStatus(t, id); status != "open" {
				t.Fatalf("%s closed without its receipt: %s", id, status)
			}
		}
	})
}
