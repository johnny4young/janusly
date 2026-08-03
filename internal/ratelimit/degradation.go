// Rate-limiter degradation tracker, ported from the reference: fail-open
// keeps a store outage from cascading into 429s, but silence is an
// observability gap — the tracker makes the blip visible WITHOUT touching
// the fail-open posture. In-memory per-process state; the audit trail
// dedupes per (bucket, UTC day) — infrastructure outages are global
// events, so the dedup key deliberately OMITS the org — with a
// belt-and-suspenders DB check so multi-replica deployments degrading
// together still write ONE row. orgId uses the "system" sentinel. All
// audit writes are best-effort: in the pilot the audited store IS the
// failing store, so during the outage itself the in-memory snapshot is
// the surviving signal (the /health surface reads it).
package ratelimit

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
)

func init() {
	// Reference actions written by its untyped data-layer system writer —
	// admitted here without counting against the typed-catalog pin.
	audit.RegisterPilotAction("rate_limit.degraded")
	audit.RegisterPilotAction("rate_limit.recovered")
}

// SystemOrgID is the sentinel org for infrastructure audit rows.
const SystemOrgID = "system"

// degradedBuckets is the process-wide gauge behind the reference's
// janusly_rate_limit_degraded_buckets metric: every tracker in the
// process contributes its transitions symmetrically.
var degradedBuckets atomic.Int64

// DegradedBucketCount reports the process-wide degraded-bucket total.
func DegradedBucketCount() float64 { return float64(degradedBuckets.Load()) }

type bucketState struct {
	bucket          string
	errorCount      int
	firstObservedAt string
	lastObservedAt  string
	lastError       string
	lastObservedKey string
	lastAuditedDay  string
}

// Tracker holds per-process degradation state. One instance per process,
// shared by every limiter bucket.
type Tracker struct {
	mu    sync.Mutex
	state map[string]*bucketState
	pool  *pgxpool.Pool
	now   func() time.Time
}

// NewTracker builds the process tracker over the audit pool.
func NewTracker(pool *pgxpool.Pool) *Tracker {
	return &Tracker{state: map[string]*bucketState{}, pool: pool, now: time.Now}
}

// SetNow overrides the clock (tests only).
func (t *Tracker) SetNow(now func() time.Time) { t.now = now }

// RecordError is the limiter's OnError hook: counts the error, and on the
// FIRST error of a (bucket, UTC day) writes one rate_limit.degraded audit
// row (day-boundary crossings re-emit so a sustained outage stays visible).
// NEVER panics past the limiter's fireHook.
func (t *Tracker) RecordError(bucket, key string, cause error) {
	nowIso := t.now().UTC().Format("2006-01-02T15:04:05.000Z")
	today := t.now().UTC().Format("2006-01-02")
	message := fmt.Sprintf("%v", cause)

	t.mu.Lock()
	entry, ok := t.state[bucket]
	if !ok {
		entry = &bucketState{bucket: bucket, firstObservedAt: nowIso}
		t.state[bucket] = entry
		degradedBuckets.Add(1)
	}
	entry.errorCount++
	entry.lastObservedAt = nowIso
	entry.lastError = message
	entry.lastObservedKey = key
	shouldAudit := entry.lastAuditedDay != today
	if shouldAudit {
		entry.lastAuditedDay = today
	}
	firstObservedAt := entry.firstObservedAt
	t.mu.Unlock()

	if !shouldAudit {
		return
	}
	t.writeDegradedAudit(bucket, key, message, firstObservedAt, today)
}

// RecordRecovery is the limiter's OnSuccess hook: a previously-degraded
// bucket clears and writes a one-shot rate_limit.recovered row; a healthy
// bucket is a no-op.
func (t *Tracker) RecordRecovery(bucket, _ string) {
	t.mu.Lock()
	entry, ok := t.state[bucket]
	if ok {
		delete(t.state, bucket)
		degradedBuckets.Add(-1)
	}
	t.mu.Unlock()
	if !ok {
		return
	}
	// Bounded: this hook fires exactly when infrastructure is misbehaving,
	// so an unbounded write would let a stalled database hold the caller
	// (and its rate-limit decision path) indefinitely.
	ctx, cancel := context.WithTimeout(context.Background(), degradationAuditTimeout)
	defer cancel()
	audit.SystemWrite(ctx, t.pool, SystemOrgID, "", "rate_limit.recovered", audit.Options{
		TargetType: "rate_limit_bucket", TargetID: bucket,
		Metadata: map[string]any{
			"bucket": bucket, "firstObservedAt": entry.firstObservedAt,
			"lastObservedAt": entry.lastObservedAt, "errorCount": entry.errorCount,
		},
	})
}

// degradationAuditTimeout bounds the best-effort audit writes below.
const degradationAuditTimeout = 5 * time.Second

// writeDegradedAudit dedupes against the DB before inserting: a prior
// replica may already have written today's row for this bucket.
func (t *Tracker) writeDegradedAudit(bucket, key, message, firstObservedAt, today string) {
	// Same bound as the recovery path: degraded infrastructure must not
	// turn a best-effort audit into an unbounded wait.
	ctx, cancel := context.WithTimeout(context.Background(), degradationAuditTimeout)
	defer cancel()
	var existing int
	err := t.pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'rate_limit.degraded'
		  AND created_at >= $2::date AND metadata @> jsonb_build_object('bucket', $3::text)`,
		SystemOrgID, today, bucket).Scan(&existing)
	if err != nil {
		// The audited store is the failing store: expected mid-outage.
		slog.Warn("[rate-limit] degraded audit dedupe check failed", "bucket", bucket, "error", err)
		return
	}
	if existing > 0 {
		return
	}
	audit.SystemWrite(ctx, t.pool, SystemOrgID, "", "rate_limit.degraded", audit.Options{
		TargetType: "rate_limit_bucket", TargetID: bucket,
		Metadata: map[string]any{
			"bucket": bucket, "firstObservedAt": firstObservedAt,
			"lastObservedKey": key, "lastError": message,
		},
	})
}

// PublicBucket is the public-safe health projection of one degraded bucket.
type PublicBucket struct {
	Bucket          string `json:"bucket"`
	ErrorCount      int    `json:"errorCount"`
	FirstObservedAt string `json:"firstObservedAt"`
	LastObservedAt  string `json:"lastObservedAt"`
}

// PublicHealth is the open GET /health block: raw error strings and the
// observed key are withheld.
type PublicHealth struct {
	Healthy         bool           `json:"healthy"`
	DegradedBuckets []PublicBucket `json:"degradedBuckets"`
}

// AdminBucket adds triage fields never exposed on the open route.
type AdminBucket struct {
	PublicBucket
	LastError       string `json:"lastError"`
	LastObservedKey string `json:"lastObservedKey"`
}

// AdminHealth is the admin GET /system/rate-limiter snapshot.
type AdminHealth struct {
	Healthy         bool          `json:"healthy"`
	DegradedBuckets []AdminBucket `json:"degradedBuckets"`
}

// Public returns the public-safe snapshot.
func (t *Tracker) Public() PublicHealth {
	t.mu.Lock()
	defer t.mu.Unlock()
	buckets := make([]PublicBucket, 0, len(t.state))
	for _, entry := range t.state {
		buckets = append(buckets, PublicBucket{
			Bucket: entry.bucket, ErrorCount: entry.errorCount,
			FirstObservedAt: entry.firstObservedAt, LastObservedAt: entry.lastObservedAt,
		})
	}
	return PublicHealth{Healthy: len(buckets) == 0, DegradedBuckets: buckets}
}

// Admin returns the full triage snapshot.
func (t *Tracker) Admin() AdminHealth {
	t.mu.Lock()
	defer t.mu.Unlock()
	buckets := make([]AdminBucket, 0, len(t.state))
	for _, entry := range t.state {
		buckets = append(buckets, AdminBucket{
			PublicBucket: PublicBucket{
				Bucket: entry.bucket, ErrorCount: entry.errorCount,
				FirstObservedAt: entry.firstObservedAt, LastObservedAt: entry.lastObservedAt,
			},
			LastError: entry.lastError, LastObservedKey: entry.lastObservedKey,
		})
	}
	return AdminHealth{Healthy: len(buckets) == 0, DegradedBuckets: buckets}
}
