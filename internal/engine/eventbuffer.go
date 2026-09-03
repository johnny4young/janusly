// Ordered buffer for the run_events a completion-family transaction
// appends. Sites add rows in causal order; inCompletionTx flushes
// the whole buffer in ONE CopyFrom round trip right before the stream
// notify, instead of one INSERT per event. Payload bytes, ids, and
// created_at values are exactly what the per-row inserts produced — the
// (created_at, id) keyset defines read order, so batching changes round
// trips only, never the timeline.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

type runEventBuffer struct {
	rows []store.InsertRunEventsParams
}

// add appends one event with a node scope.
func (b *runEventBuffer) add(id, runID, nodeID, kind string, payload json.RawMessage, at time.Time) {
	created := at
	b.rows = append(b.rows, store.InsertRunEventsParams{
		ID: id, RunID: runID,
		NodeID: pgtype.Text{String: nodeID, Valid: nodeID != ""},
		Type:   kind, Payload: payload, CreatedAt: &created,
	})
}

// flush writes every buffered event in one COPY. Empty buffers no-op.
func (b *runEventBuffer) flush(ctx context.Context, q *store.Queries) error {
	if len(b.rows) == 0 {
		return nil
	}
	inserted, err := q.InsertRunEvents(ctx, b.rows)
	if err != nil {
		return fmt.Errorf("insert %d run events: %w", len(b.rows), err)
	}
	if inserted != int64(len(b.rows)) {
		return fmt.Errorf("insert run events: %d of %d rows landed", inserted, len(b.rows))
	}
	b.rows = b.rows[:0]
	return nil
}
