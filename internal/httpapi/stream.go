// Live run streaming over SSE, shaped to the contract protocol the web
// already speaks (fetch + ReadableStream, never EventSource): a retry hint
// and connected comment on open, database catch-up from the Last-Event-ID
// composite cursor (bounded, with the catchup-truncated reconnect signal),
// then the live tail — driven here by the Postgres event notify instead of
// the contract's Redis hub, with a polling fallback so a lost notification
// only delays, never loses.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

const (
	streamRetryHintMs = 3_000
	streamHeartbeat   = 25 * time.Second
	streamCatchupMax  = 500
	// With a healthy LISTEN connection the wake channel delivers
	// sub-second latency and the poll is pure loss insurance; only a
	// degraded hub needs the tight cadence. At hundreds of open run
	// views the difference is ~1000 idle queries/s versus ~70.
	streamPollFallback         = time.Second
	streamPollFallbackListenOK = 15 * time.Second
)

// streamHub fans Postgres run-event notifications to per-run subscribers.
type streamHub struct {
	mu        sync.Mutex
	subs      map[string][]chan struct{}
	listening atomic.Bool
}

func newStreamHub() *streamHub {
	return &streamHub{subs: map[string][]chan struct{}{}}
}

func (h *streamHub) subscribe(runID string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	h.subs[runID] = append(h.subs[runID], ch)
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		subs := h.subs[runID]
		for i, candidate := range subs {
			if candidate == ch {
				h.subs[runID] = append(subs[:i], subs[i+1:]...)
				break
			}
		}
		if len(h.subs[runID]) == 0 {
			delete(h.subs, runID)
		}
	}
}

func (h *streamHub) wake(runID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subs[runID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// listen owns the LISTEN connection; loss degrades to per-subscriber
// polling until resubscribed.
func (h *streamHub) listen(ctx context.Context, pool *pgxpool.Pool) {
	for {
		if ctx.Err() != nil {
			return
		}
		pooled, err := pool.Acquire(ctx)
		if err == nil {
			conn := pooled.Hijack()
			if _, listenErr := conn.Exec(ctx, "listen janusly_run_events"); listenErr == nil {
				h.listening.Store(true)
				for {
					notification, waitErr := conn.WaitForNotification(ctx)
					if waitErr != nil {
						break
					}
					h.wake(notification.Payload)
				}
				h.listening.Store(false)
			}
			_ = conn.Close(context.Background())
		}
		if ctx.Err() != nil {
			return
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return
		}
	}
}

// streamRun handles GET /runs/{runId}/stream with the contract's guard:
// an unknown or cross-org run is the indistinguishable 403.
func (s *V1Server) streamRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) != 3 || parts[2] != "stream" {
		writeV1Error(w, rc.id, http.StatusNotFound, "not_found", "Not found", nil)
		return
	}
	runID := parts[1]
	q := store.New(s.pool)
	if _, err := q.GetRun(r.Context(), store.GetRunParams{ID: runID, OrgID: rc.orgID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(w, rc.id, http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
			return
		}
		s.internal(w, rc, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.internal(w, rc, errors.New("streaming unsupported"))
		return
	}

	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	write := func(text string) bool {
		if _, err := fmt.Fprint(w, text); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write(fmt.Sprintf("retry: %d\n\n", streamRetryHintMs)) || !write(": connected\n\n") {
		return
	}

	// Catch-up boundary from the composite Last-Event-ID; absent means from
	// the very beginning — the deliberate overlap the web dedupes by id.
	cursorAt := time.Time{}
	cursorID := ""
	if raw := r.Header.Get("Last-Event-ID"); raw != "" {
		if at, id, ok := parseEventsCursor(raw); ok {
			cursorAt, cursorID = at, id
		}
	}

	wake, unsubscribe := s.hub.subscribe(runID)
	defer unsubscribe()
	heartbeat := time.NewTicker(streamHeartbeat)
	defer heartbeat.Stop()
	lastStatus := ""

	for {
		rows, err := q.ListRunEventsAfter(r.Context(), store.ListRunEventsAfterParams{
			RunID: runID, AfterCreatedAt: cursorAt, AfterID: cursorID,
			PageLimit: streamCatchupMax + 1,
		})
		if err != nil {
			return
		}
		page := rows
		truncated := len(rows) > streamCatchupMax
		if truncated {
			page = rows[:streamCatchupMax]
		}
		for _, row := range page {
			frame := map[string]any{
				"kind": "event", "id": row.ID, "nodeId": textOrNull(row.NodeID),
				"type": row.Type, "payload": rawOrNull(row.Payload),
				"createdAt": timeOrNull(row.CreatedAt),
			}
			data, _ := json.Marshal(frame)
			frameID := row.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z") + "|" + row.ID
			if !write("id: " + frameID + "\nevent: run-event\ndata: " + string(data) + "\n\n") {
				return
			}
			cursorAt, cursorID = *row.CreatedAt, row.ID
		}
		if truncated {
			data, _ := json.Marshal(map[string]any{"kind": "catchup-truncated", "replayed": len(page)})
			write("event: catchup-truncated\ndata: " + string(data) + "\n\n")
			// The browser must reconnect from its last cursor before it can
			// safely join the live tail.
			return
		}

		// Status frame on every change, terminal included — the web's
		// polling shutdown reads it.
		if run, err := q.GetRunOwner(r.Context(), runID); err == nil && run.Status != lastStatus {
			lastStatus = run.Status
			data, _ := json.Marshal(map[string]any{"kind": "run.status", "status": run.Status})
			if !write("event: run-status\ndata: " + string(data) + "\n\n") {
				return
			}
		}

		pollFallback := streamPollFallback
		if s.hub.listening.Load() {
			pollFallback = streamPollFallbackListenOK
		}
		// A heartbeat only proves the connection is alive; it does not mean
		// new events exist, so it must not cost the two catch-up queries a
		// wake or a poll fallback does.
		fallback := time.NewTimer(pollFallback)
	wait:
		for {
			select {
			case <-wake:
				break wait
			case <-fallback.C:
				break wait
			case <-heartbeat.C:
				if !write(": keep-alive\n\n") {
					fallback.Stop()
					return
				}
			case <-r.Context().Done():
				fallback.Stop()
				return
			}
		}
		fallback.Stop()
	}
}
