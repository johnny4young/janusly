//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func seedQueueDeadLetter(t *testing.T, org, id, status, message string, createdAt time.Time) {
	t.Helper()
	pool := testPool(t)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO dead_letters (id, org_id, run_id, node_id, attempt, workflow_json, node_json, error_json, status, created_at)
		VALUES ($1, $2, $3, $4, 1,
		  '{"id":"wf-q","name":"Queue Fixture"}', '{"id":"call","type":"http"}',
		  jsonb_build_object('message', $5::text), $6, $7)`,
		id, org, "run-"+id, "node-"+id, message, status, createdAt)
	if err != nil {
		t.Fatalf("seed dead letter %s: %v", id, err)
	}
}

func seedQueueRecoveryItem(t *testing.T, org, id, deadLetterID, severity, owner string, slaTargetAt time.Time) {
	t.Helper()
	pool := testPool(t)
	_, err := pool.Exec(context.Background(), `
		INSERT INTO recovery_items (id, org_id, dead_letter_id, severity, status, sla_target_at, owner)
		VALUES ($1, $2, $3, $4, 'open', $5, NULLIF($6, ''))`,
		id, org, deadLetterID, severity, slaTargetAt, owner)
	if err != nil {
		t.Fatalf("seed recovery item %s: %v", id, err)
	}
}

func queueItemIDs(t *testing.T, body map[string]any) []string {
	t.Helper()
	raw, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("items expected: %+v", body)
	}
	ids := make([]string, 0, len(raw))
	for _, item := range raw {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	return ids
}

// The recovery-queue read-model: server-side filters before the cap,
// four total-order sorts with honest keyset pages, a cursor that only
// resumes under the sort that minted it, and the bare /dlq array.
func TestRecoveryQueueReadModel(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Millisecond)
	past := now.Add(-48 * time.Hour)

	// dl-a: oldest (two days ago), open, P1 owned by the caller, earliest SLA.
	// dl-b: an hour ago, replayed, P3. dl-c: newest, open, NO recovery item.
	dlA, dlB, dlC := "dlq-a-"+suffix, "dlq-b-"+suffix, "dlq-c-"+suffix
	seedQueueDeadLetter(t, h.org, dlA, "open", "connect timeout upstream-alpha", past)
	seedQueueDeadLetter(t, h.org, dlB, "replayed", "boom bravo", now.Add(-time.Hour))
	seedQueueDeadLetter(t, h.org, dlC, "open", "charlie failed", now)
	seedQueueRecoveryItem(t, h.org, "ri-a-"+suffix, dlA, "p1", "api-tester", past.Add(time.Hour))
	seedQueueRecoveryItem(t, h.org, "ri-b-"+suffix, dlB, "p3", "", now.Add(24*time.Hour))
	// Another tenant's row must never surface.
	seedQueueDeadLetter(t, h.org+"-other", "dlq-x-"+suffix, "open", "other org", now)

	// Default sort: newest first, overlay inline, no next page.
	res := h.call("GET", "/dlq/queue", nil, "")
	if res.status != 200 || res.body["hasMore"] != false || res.body["nextCursor"] != nil {
		t.Fatalf("page envelope: %d %+v", res.status, res.body)
	}
	if ids := queueItemIDs(t, res.body); len(ids) != 3 || ids[0] != dlC || ids[1] != dlB || ids[2] != dlA {
		t.Fatalf("newest order: %v", ids)
	}
	items := res.body["items"].([]any)
	if items[0].(map[string]any)["recovery"] != nil {
		t.Fatalf("dl-c must have no overlay")
	}
	overlayA := items[2].(map[string]any)["recovery"].(map[string]any)
	if overlayA["severity"] != "p1" || overlayA["owner"] != "api-tester" {
		t.Fatalf("dl-a overlay: %+v", overlayA)
	}

	// Keyset paging: limit=2 → honest hasMore + a cursor that resumes.
	res = h.call("GET", "/dlq/queue?limit=2", nil, "")
	if res.body["hasMore"] != true || res.body["nextCursor"] == nil {
		t.Fatalf("page 1: %+v", res.body)
	}
	cursor := res.body["nextCursor"].(string)
	res = h.call("GET", "/dlq/queue?limit=2&cursor="+cursor, nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != dlA || res.body["hasMore"] != false {
		t.Fatalf("page 2: %v %+v", ids, res.body)
	}

	// Severity sort: p1 → p3 → the no-item NULLS LAST tail, page by page.
	var got []string
	cursorParam := ""
	for range 3 {
		res = h.call("GET", "/dlq/queue?sort=severity&limit=1"+cursorParam, nil, "")
		got = append(got, queueItemIDs(t, res.body)...)
		if res.body["nextCursor"] == nil {
			break
		}
		cursorParam = "&cursor=" + res.body["nextCursor"].(string)
	}
	if len(got) != 3 || got[0] != dlA || got[1] != dlB || got[2] != dlC {
		t.Fatalf("severity pages: %v", got)
	}
	// A cursor minted under severity is IGNORED under newest → page 1.
	res = h.call("GET", "/dlq/queue?sort=newest"+cursorParam, nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 3 || ids[0] != dlC {
		t.Fatalf("cross-sort cursor must reset: %v", ids)
	}

	// SLA sort: earliest target first, no-item rows last.
	res = h.call("GET", "/dlq/queue?sort=sla", nil, "")
	if ids := queueItemIDs(t, res.body); ids[0] != dlA || ids[1] != dlB || ids[2] != dlC {
		t.Fatalf("sla order: %v", ids)
	}

	// Filters: owner=me, severity, status, search, day.
	res = h.call("GET", "/dlq/queue?owner=me", nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != dlA {
		t.Fatalf("owner=me: %v", ids)
	}
	res = h.call("GET", "/dlq/queue?severity=p3", nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != dlB {
		t.Fatalf("severity filter: %v", ids)
	}
	res = h.call("GET", "/dlq/queue?status=replayed", nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != dlB {
		t.Fatalf("status filter: %v", ids)
	}
	res = h.call("GET", "/dlq/queue?search=upstream-alpha", nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != dlA {
		t.Fatalf("search: %v", ids)
	}
	res = h.call("GET", "/dlq/queue?day="+past.Format("2006-01-02"), nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != dlA {
		t.Fatalf("day drill-in: %v", ids)
	}
	// Malformed day is dropped, not an error.
	res = h.call("GET", "/dlq/queue?day=not-a-day", nil, "")
	if len(queueItemIDs(t, res.body)) != 3 {
		t.Fatalf("malformed day must be ignored")
	}

	// Out-of-enum filters are 400s, not empty pages.
	for _, bad := range []string{"?status=nope", "?severity=p9", "?sort=zigzag"} {
		if res = h.call("GET", "/dlq/queue"+bad, nil, ""); res.status != 400 {
			t.Fatalf("%s must 400: %d", bad, res.status)
		}
	}

	// Bare /dlq stays an ARRAY with the same join + filters.
	req, _ := http.NewRequest("GET", h.server.URL+"/dlq?severity=p1", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	rawRes, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("bare /dlq: %v", err)
	}
	defer rawRes.Body.Close()
	var array []map[string]any
	if err := json.NewDecoder(rawRes.Body).Decode(&array); err != nil {
		t.Fatalf("bare /dlq must be an array: %v", err)
	}
	if len(array) != 1 || array[0]["id"] != dlA || array[0]["recovery"] == nil {
		t.Fatalf("bare array: %+v", array)
	}
}
