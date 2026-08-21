// Run-event archival: the retention tier that lets an organization keep a
// durable copy of what the sweep is about to delete.
//
// Ordering is the whole point. The batch is READ first, serialized to
// JSONL, and written to the object store; only the exact ids that made it
// into a stored object are deleted. A failed or unconfigured object store
// means nothing is deleted from that batch — expiry is not worth silent
// data loss, and the next sweep retries the same rows.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/johnny4young/janusly/internal/objectstore"
	"github.com/johnny4young/janusly/internal/store"
)

// archiveObjectKey names one exported batch. Callers pass the batch's
// first event id so two batches in the same second cannot collide.
func archiveObjectKey(orgID, cutoffDay, firstEventID string) string {
	return fmt.Sprintf("orgs/%s/archive/run-events/%s/%s.jsonl", orgID, cutoffDay, firstEventID)
}

// archiveExpiredRunEvents exports one batch and deletes exactly what it
// exported. Returns the number of rows deleted; zero means the batch is
// still in the database (nothing expired, or the export could not be
// stored).
func (e *Engine) archiveExpiredRunEvents(
	ctx context.Context, q *store.Queries, orgID string, cutoff time.Time, batchSize int32,
) (int, error) {
	rows, err := q.SelectExpiredRunEventsBatch(ctx, store.SelectExpiredRunEventsBatchParams{
		TargetOrg: orgID, Cutoff: cutoff, BatchSize: batchSize,
	})
	if err != nil {
		return 0, fmt.Errorf("read archivable run events: %w", err)
	}
	if len(rows) == 0 {
		return 0, nil
	}

	var body bytes.Buffer
	ids := make([]string, 0, len(rows))
	encoder := json.NewEncoder(&body)
	for _, row := range rows {
		record := map[string]any{
			"id": row.ID, "runId": row.RunID, "type": row.Type,
			"payload": json.RawMessage(row.Payload),
		}
		if row.NodeID.Valid {
			record["nodeId"] = row.NodeID.String
		}
		if row.CreatedAt != nil {
			record["createdAt"] = row.CreatedAt.UTC().Format(time.RFC3339Nano)
		}
		if err := encoder.Encode(record); err != nil {
			return 0, fmt.Errorf("encode archived run event: %w", err)
		}
		ids = append(ids, row.ID)
	}

	key := archiveObjectKey(orgID, cutoff.UTC().Format("2006-01-02"), ids[0])
	result := objectstore.Put(ctx, "", key, body.Bytes(), "application/x-ndjson")
	if !result.Ok {
		// Nothing was stored, so nothing may be deleted. The sweep will
		// meet these rows again on its next pass.
		return 0, fmt.Errorf("archive run events to %s: %s", key, result.Error)
	}
	deleted, err := q.DeleteRunEventsByID(ctx, ids)
	if err != nil {
		return 0, fmt.Errorf("delete archived run events: %w", err)
	}
	return int(deleted), nil
}
