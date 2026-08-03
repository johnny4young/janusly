//go:build integration

package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Metadata + organization: full upsert (audit projects AI guidance to
// {configured, bytes}), narrow folder/tag routes that touch only their
// column, distinct dropdowns excluding tombstones, and the bulk
// folder/tag collection ops.
func TestWorkflowMetadataAndOrganization(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())

	save := func(id string) {
		res := h.call("POST", "/v1/workflows/save", map[string]any{
			"id": id, "name": id, "dslVersion": "1.0",
			"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
			"edges": []any{},
		}, "")
		if res.status != 200 {
			t.Fatalf("save %s: %+v", id, res.body)
		}
	}
	wfA, wfB := "wf-meta-a-"+suffix, "wf-meta-b-"+suffix
	save(wfA)
	save(wfB)

	// Missing metadata GETs as null, never 404.
	res := h.call("GET", "/workflows/"+wfA+"/metadata", nil, "")
	if res.status != 200 || res.body["metadata"] != nil {
		t.Fatalf("missing metadata: %d %+v", res.status, res.body)
	}

	// Full upsert + audit projection of the AI guidance.
	res = h.call("POST", "/workflows/"+wfA+"/metadata", map[string]any{
		"metadata": map[string]any{
			"owners": []any{"ana"}, "tags": []any{"facturación", "críticos"},
			"description": "Flujo de cobros", "severityDefault": "p2",
			"folder": "Finanzas", "aiGuidanceMarkdown": "SECRETO-NO-DEBE-AUDITARSE",
		},
	}, "")
	if res.status != 200 {
		t.Fatalf("upsert metadata: %d %+v", res.status, res.body)
	}
	var auditMetadata string
	_ = pool.QueryRow(ctx,
		`SELECT metadata::text FROM audit_logs WHERE org_id = $1 AND action = 'workflow.metadata.set' ORDER BY created_at DESC LIMIT 1`,
		h.org).Scan(&auditMetadata)
	if strings.Contains(auditMetadata, "SECRETO-NO-DEBE-AUDITARSE") || !strings.Contains(auditMetadata, `"configured": true`) {
		t.Fatalf("audit must project AI guidance: %s", auditMetadata)
	}
	// The reference requires the wrapper; a direct shape must never silently
	// replace the row with empty metadata.
	res = h.call("POST", "/workflows/"+wfA+"/metadata", map[string]any{"description": "lost"}, "")
	if res.status != 422 || res.body["code"] != "workflow_metadata_invalid" {
		t.Fatalf("unwrapped metadata must fail closed: %d %+v", res.status, res.body)
	}

	// The NARROW folder route leaves the rest untouched.
	if res = h.call("POST", "/workflows/"+wfB+"/folder", map[string]any{"folder": "Finanzas"}, ""); res.status != 200 {
		t.Fatalf("narrow folder: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/workflows/"+wfA+"/folder", map[string]any{"folder": "Operaciones"}, "")
	if res.status != 200 {
		t.Fatalf("move folder: %d", res.status)
	}
	res = h.call("GET", "/workflows/"+wfA+"/metadata", nil, "")
	metadata := res.body["metadata"].(map[string]any)
	if metadata["folder"] != "Operaciones" || metadata["description"] != "Flujo de cobros" {
		t.Fatalf("narrow folder must not wipe the row: %+v", metadata)
	}

	// The active list folds metadata and buffered work into each row, and its
	// tag/folder filters apply before the cap. An abandoned backfill claim is
	// visible after the same five-minute lease as the reference implementation.
	var versionID string
	if err := pool.QueryRow(ctx,
		`SELECT id FROM workflow_versions WHERE org_id = $1 AND workflow_id = $2 ORDER BY version DESC LIMIT 1`,
		h.org, wfA).Scan(&versionID); err != nil {
		t.Fatalf("latest version: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO trigger_events
		(id, org_id, trigger_type, workflow_id, workflow_version_id, node_id, status, payload_json,
		 backfill_claim_token, backfill_claimed_at)
		VALUES ($1, $2, 'email_received', $3, $4, 'n', 'buffered', '{}'::jsonb, NULL, NULL),
		       ($5, $2, 'email_received', $3, $4, 'n', 'backfilling', '{}'::jsonb, 'stale', now() - interval '6 minutes'),
		       ($6, $2, 'email_received', $3, $4, 'n', 'backfilling', '{}'::jsonb, 'fresh', now())`,
		"buffered-"+suffix, h.org, wfA, versionID, "stale-"+suffix, "fresh-"+suffix); err != nil {
		t.Fatalf("seed buffered events: %v", err)
	}
	res = h.call("GET", "/v1/workflows?tag=facturaci%C3%B3n&tag=cr%C3%ADticos&folder=Operaciones&q="+wfA, nil, "")
	rows := res.body["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("metadata filters must select wfA: %+v", res.body)
	}
	listRow := rows[0].(map[string]any)
	if listRow["folder"] != "Operaciones" || listRow["bufferedTriggerCount"] != float64(2) ||
		!strings.Contains(fmt.Sprint(listRow["tags"]), "facturación") {
		t.Fatalf("active list metadata/buffer fold: %+v", listRow)
	}
	res = h.call("GET", "/v1/workflows?tag=facturaci%C3%B3n&tag=missing", nil, "")
	if rows = res.body["data"].([]any); len(rows) != 0 {
		t.Fatalf("repeated tags must AND together: %+v", rows)
	}

	// Distinct dropdowns.
	res = h.call("GET", "/workflows/tags", nil, "")
	tags := fmt.Sprint(res.body["tags"])
	if !strings.Contains(tags, "facturación") {
		t.Fatalf("tags dropdown: %+v", res.body)
	}
	res = h.call("GET", "/workflows/folders", nil, "")
	folders := fmt.Sprint(res.body["folders"])
	if !strings.Contains(folders, "Operaciones") || !strings.Contains(folders, "Finanzas") {
		t.Fatalf("folders dropdown: %+v", res.body)
	}

	// Bulk: rename folder, assign tag, rename tag, delete tag, delete folder.
	if res = h.call("POST", "/workflows/folders/rename", map[string]any{"from": "Finanzas", "to": "Tesorería"}, ""); res.status != 200 ||
		res.body["affected"] != float64(1) {
		t.Fatalf("folder rename: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/workflows/tags/assign", map[string]any{
		"workflowIds": []any{wfA, wfB, "ghost-" + suffix}, "tag": "q3",
	}, ""); res.status != 200 || res.body["affected"] != float64(2) {
		t.Fatalf("tag assign must skip unowned ids: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/workflows/tags/rename", map[string]any{"from": "q3", "to": "q4"}, ""); res.status != 200 ||
		res.body["affected"] != float64(2) {
		t.Fatalf("tag rename: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/workflows/tags/delete", map[string]any{"tag": "q4"}, ""); res.status != 200 ||
		res.body["affected"] != float64(2) {
		t.Fatalf("tag delete: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/workflows/folders/delete", map[string]any{"folder": "Tesorería"}, ""); res.status != 200 {
		t.Fatalf("folder delete: %d", res.status)
	}

	// A soft-deleted workflow's tags vanish from the dropdown.
	if res = h.call("DELETE", "/workflows/"+wfA, nil, ""); res.status != 200 {
		t.Fatalf("soft delete: %d", res.status)
	}
	res = h.call("GET", "/workflows/tags", nil, "")
	if strings.Contains(fmt.Sprint(res.body["tags"]), "facturación") {
		t.Fatalf("tombstoned tags must leave the dropdown: %+v", res.body)
	}
	// And its metadata routes answer the same opaque 404.
	if res = h.call("GET", "/workflows/"+wfA+"/metadata", nil, ""); res.status != 404 {
		t.Fatalf("tombstone metadata must 404: %d", res.status)
	}
}
