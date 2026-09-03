// Two-tier infrastructure health, implements the contract's health
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

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	queueLagWarnSecondsDefault            = 60
	maintenanceQueueLagWarnSecondsDefault = 300
	queueLagWarnSecondsMax                = 86_400
	queueSnapshotTTL                      = 5 * time.Second
	queueSnapshotFailureTTL               = 1 * time.Second
	queueSnapshotTimeout                  = 2 * time.Second
)

// queueSnapshot is the contract's QueueHealthSnapshot.
type queueSnapshot struct {
	Waiting              int  `json:"waiting"`
	Active               int  `json:"active"`
	OldestWaitingSeconds *int `json:"oldestWaitingSeconds"`
	WarnSeconds          int  `json:"warnSeconds"`
}

// resolveQueueLagWarnSeconds clamps the env threshold into [1, 86400].
func resolveQueueLagWarnSeconds() int {
	return resolveQueueWarnSeconds("JANUSLY_QUEUE_LAG_WARN_SECONDS", queueLagWarnSecondsDefault)
}

func resolveMaintenanceQueueLagWarnSeconds() int {
	return resolveQueueWarnSeconds("JANUSLY_MAINTENANCE_QUEUE_LAG_WARN_SECONDS", maintenanceQueueLagWarnSecondsDefault)
}

func resolveQueueWarnSeconds(envName string, fallback int) int {
	raw := os.Getenv(envName)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 1 || parsed > queueLagWarnSecondsMax {
		return fallback
	}
	return parsed
}

// queueHealthCache coalesces snapshot reads: one flight at a time. Successful
// snapshots are cached for the normal TTL. Failures use a shorter TTL so one
// transient timeout is not projected as a multi-probe outage, while the mutex
// still prevents a scrape storm from piling onto a slow database.
type queueHealthCache struct {
	mu        sync.Mutex
	snapshot  *queueSnapshot
	fetchedAt time.Time
	failed    bool
	read      func(ctx context.Context) (*queueSnapshot, error)
	now       func() time.Time
}

func (c *queueHealthCache) get(ctx context.Context) *queueSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now
	if c.now != nil {
		now = c.now
	}
	ttl := queueSnapshotTTL
	if c.failed {
		ttl = queueSnapshotFailureTTL
	}
	if age := now().Sub(c.fetchedAt); !c.fetchedAt.IsZero() && age >= 0 && age < ttl {
		return c.snapshot
	}
	readCtx, cancel := context.WithTimeout(ctx, queueSnapshotTimeout)
	defer cancel()
	snapshot, err := c.read(readCtx)
	c.fetchedAt = now()
	if err != nil {
		c.snapshot = nil // store failure: queue reads as null, ok stays true
		c.failed = true
	} else {
		c.snapshot = snapshot
		c.failed = false
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
		age := max(int(time.Since(oldest).Seconds()), 0)
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
	// additive maintenance snapshot. Go runs maintenance loops in-process,
	// so their truthful queue-compatible projection is an always-drained lane
	// rather than unavailable telemetry.
	mux.HandleFunc("GET /system/queue", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		snapshot := s.queueCache.get(r.Context())
		if snapshot == nil {
			writeUnversioned(w, opOK(map[string]any{"queue": nil}))
			return
		}
		writeUnversioned(w, opOK(map[string]any{
			"waiting": snapshot.Waiting, "active": snapshot.Active,
			"oldestWaitingSeconds": intPtrOrNull(snapshot.OldestWaitingSeconds),
			"warnSeconds":          snapshot.WarnSeconds,
			"maintenance": queueSnapshot{
				Waiting: 0, Active: 0, WarnSeconds: resolveMaintenanceQueueLagWarnSeconds(),
			},
		}))
	}))
	// Tenant operators receive only a coarse fleet-health state. Instance IDs,
	// build commits, start times, concurrency, and replica counts are global
	// platform topology and must not cross the tenant-admin boundary.
	s.route(mux, "GET /system/workers", routeGate{auth.RoleAdmin, "org.config.write"},
		func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			rows, err := store.New(s.pool).ListWorkerInstances(r.Context())
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			staleAfter := 4 * engine.WorkerHeartbeatInterval
			now := time.Now()
			live := 0
			stale := 0
			for _, row := range rows {
				if now.Sub(row.LastSeenAt) <= staleAfter {
					live++
				} else {
					stale++
				}
			}
			status := "healthy"
			if live == 0 {
				status = "unhealthy"
			} else if stale > 0 {
				status = "degraded"
			}
			writeUnversioned(w, opOK(map[string]any{
				"status":            status,
				"staleAfterSeconds": int(staleAfter.Seconds()),
			}))
		})

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
