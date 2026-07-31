// Two-tier infrastructure health, ported from the reference's health
// routes: the open GET /health carries only public-safe blocks (the
// limiter tracker's truncated snapshot and a coarse queue {degraded} —
// never live counts or latency on an unauthenticated route), while the
// admin GET /system/queue exposes waiting/active/oldest-age from the
// Postgres queue substrate and GET /system/rate-limiter the full triage
// snapshot. The queue snapshot coalesces for 5 seconds with a hard read
// timeout; a store failure reads as queue: null while ok stays true.
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	queueLagWarnSecondsDefault = 60
	queueLagWarnSecondsMax     = 86_400
	queueSnapshotTTL           = 5 * time.Second
	queueSnapshotTimeout       = 2 * time.Second
)

// queueSnapshot is the reference's QueueHealthSnapshot.
type queueSnapshot struct {
	Waiting              int  `json:"waiting"`
	Active               int  `json:"active"`
	OldestWaitingSeconds *int `json:"oldestWaitingSeconds"`
	WarnSeconds          int  `json:"warnSeconds"`
}

// resolveQueueLagWarnSeconds clamps the env threshold into [1, 86400].
func resolveQueueLagWarnSeconds() int {
	raw := os.Getenv("JANUSLY_QUEUE_LAG_WARN_SECONDS")
	if raw == "" {
		return queueLagWarnSecondsDefault
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 1 || parsed > queueLagWarnSecondsMax {
		return queueLagWarnSecondsDefault
	}
	return parsed
}

// queueHealthCache coalesces snapshot reads: one flight at a time, both
// success and failure cached for the TTL so a scrape storm cannot pile
// onto a slow database.
type queueHealthCache struct {
	mu        sync.Mutex
	snapshot  *queueSnapshot
	fetchedAt time.Time
	read      func(ctx context.Context) (*queueSnapshot, error)
}

func (c *queueHealthCache) get(ctx context.Context) *queueSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.fetchedAt.IsZero() && time.Since(c.fetchedAt) < queueSnapshotTTL {
		return c.snapshot
	}
	readCtx, cancel := context.WithTimeout(ctx, queueSnapshotTimeout)
	defer cancel()
	snapshot, err := c.read(readCtx)
	c.fetchedAt = time.Now()
	if err != nil {
		c.snapshot = nil // store failure: queue reads as null, ok stays true
	} else {
		c.snapshot = snapshot
	}
	return c.snapshot
}

func (s *V1Server) readQueueSnapshot(ctx context.Context) (*queueSnapshot, error) {
	row, err := store.New(s.pool).QueryQueueHealth(ctx)
	if err != nil {
		return nil, err
	}
	snapshot := &queueSnapshot{
		Waiting: int(row.Waiting), Active: int(row.Active),
		WarnSeconds: resolveQueueLagWarnSeconds(),
	}
	if oldest, ok := row.OldestEligibleAt.(time.Time); ok && row.Waiting > 0 {
		age := int(time.Since(oldest).Seconds())
		if age < 0 {
			age = 0
		}
		snapshot.OldestWaitingSeconds = &age
	}
	return snapshot, nil
}

func queueDegraded(snapshot *queueSnapshot) bool {
	return snapshot.OldestWaitingSeconds != nil && *snapshot.OldestWaitingSeconds > snapshot.WarnSeconds
}

// publicQueueHealth truncates the snapshot to the unauthenticated shape.
func (s *V1Server) publicQueueHealth(ctx context.Context) any {
	snapshot := s.queueCache.get(ctx)
	if snapshot == nil {
		return nil
	}
	return map[string]any{"degraded": queueDegraded(snapshot)}
}

func (s *V1Server) mountSystemHealthRoutes(mux *http.ServeMux) {
	// Admin queue detail: workflow fields at the stable top level plus the
	// additive maintenance snapshot — null in the pilot, which runs its
	// maintenance loops in-process rather than on a second queue.
	mux.HandleFunc("GET /system/queue", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		snapshot := s.queueCache.get(r.Context())
		if snapshot == nil {
			writeLegacy(w, opOK(map[string]any{"queue": nil}))
			return
		}
		writeLegacy(w, opOK(map[string]any{
			"waiting": snapshot.Waiting, "active": snapshot.Active,
			"oldestWaitingSeconds": intPtrOrNull(snapshot.OldestWaitingSeconds),
			"warnSeconds":          snapshot.WarnSeconds,
			"maintenance":          nil,
		}))
	}))
	mux.HandleFunc("GET /system/rate-limiter", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.limiterTracker.Admin())
	}))
}

func intPtrOrNull(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}
