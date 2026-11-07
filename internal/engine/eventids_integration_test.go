//go:build integration

package engine

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// Events stamped with the same millisecond read back in the order their ids
// were generated, even when they are inserted in the opposite order.
func TestSameMillisecondRunEventsReadInGenerationOrder(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// A queued run left behind would be claimed by later worker tests.
	if err := eng.CancelRun(ctx, runID, nil); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	at := time.Now().Add(time.Hour).UTC().Truncate(time.Millisecond)
	generated := make([]string, 20)
	for index := range generated {
		generated[index] = newEventID()
	}
	q := store.New(pool)
	for _, id := range slices.Backward(generated) {
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: id, RunID: runID, OrgID: org,
			NodeID: pgtype.Text{String: "first", Valid: true},
			Type:   "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
		}); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	rows, err := q.ListRunEventsAfterForOrg(ctx, store.ListRunEventsAfterForOrgParams{
		RunID: runID, OrgID: org, AfterCreatedAt: at.Add(-time.Millisecond), AfterID: "", PageLimit: 100,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var read []string
	for _, row := range rows {
		read = append(read, row.ID)
	}
	if !slices.Equal(read, generated) {
		t.Fatalf("same-millisecond events out of generation order:\n got %v\nwant %v", read, generated)
	}
}
