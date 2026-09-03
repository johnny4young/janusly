//go:build integration

package httpapi

import (
	"fmt"
	"testing"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
)

// The audit-trail reader: keyset pages reassemble the exact trail with no
// repeats or skips (tight-loop writes share milliseconds, so the id
// tie-break is exercised for real), the action PREFIX filter narrows, and
// the wire is the contract's raw {rows, nextCursor, hasMore} page.
func TestAuditTrailKeysetRead(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)

	// Five rows in a tight loop: same-ms collisions are the interesting case.
	seeded := map[string]bool{}
	for i := range 5 {
		action := "org.role.created"
		if i%2 == 1 {
			action = "member.role.updated"
		}
		target := fmt.Sprintf("seed-%d", i)
		actor := &auth.Context{OrgID: h.org, UserID: "api-tester", Mode: auth.ModeDevHeaders, Source: auth.SourceDev}
		audit.Write(t.Context(), pool, actor, audit.Action(action), audit.Options{
			TargetType: "seed", TargetID: target,
		})
		seeded[target] = true
	}

	// Page through with limit=2: 2+2+1, cursors chaining, no dupes/skips.
	collected := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		path := "/audit?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		res := h.call("GET", path, nil, "")
		if res.status != 200 {
			t.Fatalf("page %d: %d %+v", pages, res.status, res.body)
		}
		rows := res.body["rows"].([]any)
		for _, raw := range rows {
			row := raw.(map[string]any)
			target, _ := row["targetId"].(string)
			if collected[target] {
				t.Fatalf("duplicate row across pages: %s", target)
			}
			collected[target] = true
			if row["metadata"].(map[string]any)["actor"] == nil {
				t.Fatalf("row must surface the persisted metadata: %+v", row)
			}
		}
		pages++
		if res.body["hasMore"] != true {
			break
		}
		next, _ := res.body["nextCursor"].(string)
		if next == "" {
			t.Fatalf("hasMore without cursor: %+v", res.body)
		}
		cursor = next
		if pages > 5 {
			t.Fatal("cursor never exhausted")
		}
	}
	if pages != 3 || len(collected) != 5 {
		t.Fatalf("want 5 rows across 3 pages, got %d across %d", len(collected), pages)
	}
	for target := range seeded {
		if !collected[target] {
			t.Fatalf("keyset skipped %s", target)
		}
	}

	// PREFIX filter: `org.role` matches created rows only.
	filtered := h.call("GET", "/audit?action=org.role", nil, "")
	if rows := filtered.body["rows"].([]any); len(rows) != 3 {
		t.Fatalf("prefix filter: want 3 rows, got %d", len(rows))
	}
	if filtered.body["hasMore"] != false || filtered.body["nextCursor"] != nil {
		t.Fatalf("exhausted trail shape: %+v", filtered.body)
	}

	// The compliance gate is admin: a seeded viewer reads a verbatim 403.
	seedMemberRow(t, pool, h.org, "u-aud-viewer", "v@x.com", "viewer")
	denied := h.callWithHeaders("GET", "/audit", nil, "", map[string]string{"x-user-id": "u-aud-viewer"})
	if denied.status != 403 {
		t.Fatalf("viewer must not read the trail: %d %+v", denied.status, denied.body)
	}
}
