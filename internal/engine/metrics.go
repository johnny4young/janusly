// Engine metrics on the default Prometheus registry, served by the internal
// port's /metrics. Runtime counters use the janusly_ prefix. Queue depth is
// a custom collector with a short cache so scrapes stay bounded and can never
// stampede the database.
package engine

import (
	"context"
	"maps"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/johnny4young/janusly/internal/store"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	metricClaims = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_claims_total",
		Help: "Queue claims consumed by the worker pool.",
	})
	metricNodeCompletions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "janusly_node_completions_total",
		Help: "Terminal node transitions by outcome.",
	}, []string{"outcome"})
	metricNodeRetries = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_node_retries_total",
		Help: "Retry requeues scheduled by the failure ladder.",
	})
	metricRunsTerminal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "janusly_runs_terminal_total",
		Help: "Run-level terminal transitions by status.",
	}, []string{"status"})
	metricReapedNodes = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_reaped_nodes_total",
		Help: "Stalled running nodes failed into the DLQ by the reaper.",
	})
	metricRedrives = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_redrives_total",
		Help: "Dead letters successfully redriven.",
	})
	// Node type is a closed runtime catalog, so this answers which executor is
	// slow without introducing traffic-derived cardinality.
	metricNodeExecution = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "janusly_node_execution_seconds",
		Help:    "Executor wall time per claimed node.",
		Buckets: prometheus.ExponentialBuckets(0.001, 2.5, 12),
	}, []string{"node_type"})
	// Depth cannot distinguish a healthy busy queue from a shallow queue that
	// workers stopped consuming. This measures only eligible-to-claim time:
	// retry backoff is represented by the durable eligibility clock and is not
	// charged to worker latency.
	metricQueueWait = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "janusly_queue_wait_seconds",
		Help:    "Time a workflow node spent eligible but unclaimed.",
		Buckets: prometheus.ExponentialBuckets(0.001, 3, 14),
	})
)

// QueueDepthCollector exposes janusly_queue_depth{state} from one bounded
// statement whose per-state counts use the queue's partial indexes. It is
// cached briefly so concurrent scrapes coalesce.
type QueueDepthCollector struct {
	pool  *pgxpool.Pool
	desc  *prometheus.Desc
	mu    sync.Mutex
	at    time.Time
	cache map[string]float64
}

// NewQueueDepthCollector builds (but does not register) the collector.
func NewQueueDepthCollector(pool *pgxpool.Pool) *QueueDepthCollector {
	return &QueueDepthCollector{
		pool: pool,
		desc: prometheus.NewDesc("janusly_queue_depth",
			"Open run-node rows by state.", []string{"state"}, nil),
	}
}

// Describe implements prometheus.Collector.
func (c *QueueDepthCollector) Describe(ch chan<- *prometheus.Desc) { ch <- c.desc }

// Collect implements prometheus.Collector with a 5-second cache.
func (c *QueueDepthCollector) Collect(ch chan<- prometheus.Metric) {
	// Refresh outside the lock: a slow query must not stall every concurrent
	// scrape for its full timeout. Racing scrapes may both refresh; the
	// cache is advisory, not a consistency boundary.
	c.mu.Lock()
	stale := time.Since(c.at) > 5*time.Second
	c.mu.Unlock()
	if stale {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		rows, err := c.pool.Query(ctx,
			`SELECT state, depth FROM (
				SELECT 'pending'::text AS state, count(*)::bigint AS depth
				FROM run_nodes WHERE status = 'pending'
				UNION ALL
				SELECT 'queued'::text AS state, count(*)::bigint AS depth
				FROM run_nodes WHERE status = 'queued'
				UNION ALL
				SELECT 'running'::text AS state, count(*)::bigint AS depth
				FROM run_nodes WHERE status = 'running'
				UNION ALL
				SELECT 'waiting'::text AS state, count(*)::bigint AS depth
				FROM run_nodes WHERE status = 'waiting'
			) AS queue_depth`)
		if err == nil {
			fresh := map[string]float64{"pending": 0, "queued": 0, "running": 0, "waiting": 0}
			for rows.Next() {
				var state string
				var count int64
				if rows.Scan(&state, &count) == nil {
					fresh[state] = float64(count)
				}
			}
			rows.Close()
			// Only cache a COMPLETE scan: a mid-iteration failure would
			// otherwise publish partial queue depths as authoritative for
			// the next 5s, which reads as a queue that suddenly drained.
			if rows.Err() == nil {
				c.mu.Lock()
				c.cache, c.at = fresh, time.Now()
				c.mu.Unlock()
			}
		}
	}
	c.mu.Lock()
	snapshot := make(map[string]float64, len(c.cache))
	maps.Copy(snapshot, c.cache)
	c.mu.Unlock()
	for state, value := range snapshot {
		ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, value, state)
	}
}

// WorkflowQueueCollector exposes workflow_queue_waiting_jobs and
// workflow_queue_active_jobs. Waiting uses eligibility semantics: queued,
// parent run active, and any wake-up already due.
type WorkflowQueueCollector struct {
	pool        *pgxpool.Pool
	waitingDesc *prometheus.Desc
	activeDesc  *prometheus.Desc
	mu          sync.Mutex
	at          time.Time
	waiting     float64
	active      float64
}

// NewWorkflowQueueCollector builds (but does not register) the collector.
func NewWorkflowQueueCollector(pool *pgxpool.Pool) *WorkflowQueueCollector {
	return &WorkflowQueueCollector{
		pool: pool,
		waitingDesc: prometheus.NewDesc("workflow_queue_waiting_jobs",
			"Eligible queued workflow nodes awaiting a worker.", nil, nil),
		activeDesc: prometheus.NewDesc("workflow_queue_active_jobs",
			"Workflow nodes currently executing.", nil, nil),
	}
}

// Describe implements prometheus.Collector.
func (c *WorkflowQueueCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.waitingDesc
	ch <- c.activeDesc
}

// Collect implements prometheus.Collector with a 5-second cache.
func (c *WorkflowQueueCollector) Collect(ch chan<- prometheus.Metric) {
	// Same posture as QueueDepthCollector: the query runs outside the lock so
	// a slow scrape never blocks the others.
	c.mu.Lock()
	stale := time.Since(c.at) > 5*time.Second
	c.mu.Unlock()
	if stale {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if row, err := store.New(c.pool).QueryQueueHealth(ctx); err == nil {
			c.mu.Lock()
			c.waiting, c.active, c.at = float64(row.Waiting), float64(row.Active), time.Now()
			c.mu.Unlock()
		}
	}
	c.mu.Lock()
	waiting, active := c.waiting, c.active
	c.mu.Unlock()
	ch <- prometheus.MustNewConstMetric(c.waitingDesc, prometheus.GaugeValue, waiting)
	ch <- prometheus.MustNewConstMetric(c.activeDesc, prometheus.GaugeValue, active)
}

// DeadLetterCollector exposes janusly_dead_letters{status}: the production
// recovery queue by status, across tenants, from the partial (org, status)
// index. Cached like the queue depth so scrapes coalesce.
type DeadLetterCollector struct {
	pool  *pgxpool.Pool
	desc  *prometheus.Desc
	mu    sync.Mutex
	at    time.Time
	cache map[string]float64
}

// NewDeadLetterCollector builds (but does not register) the collector.
func NewDeadLetterCollector(pool *pgxpool.Pool) *DeadLetterCollector {
	return &DeadLetterCollector{
		pool: pool,
		desc: prometheus.NewDesc("janusly_dead_letters",
			"Production dead letters by status, across tenants.", []string{"status"}, nil),
	}
}

// Describe implements prometheus.Collector.
func (c *DeadLetterCollector) Describe(ch chan<- *prometheus.Desc) { ch <- c.desc }

// Collect implements prometheus.Collector with a 5-second cache.
func (c *DeadLetterCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.Lock()
	stale := time.Since(c.at) > 5*time.Second
	c.mu.Unlock()
	if stale {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		rows, err := c.pool.Query(ctx,
			`SELECT status, count(*)::bigint FROM dead_letters WHERE replay_mode IS NULL GROUP BY status`)
		if err == nil {
			fresh := map[string]float64{"open": 0, "replayed": 0, "resolved": 0}
			for rows.Next() {
				var status string
				var count int64
				if rows.Scan(&status, &count) == nil {
					fresh[status] = float64(count)
				}
			}
			rows.Close()
			if rows.Err() == nil {
				c.mu.Lock()
				c.cache, c.at = fresh, time.Now()
				c.mu.Unlock()
			}
		}
	}
	c.mu.Lock()
	snapshot := make(map[string]float64, len(c.cache))
	maps.Copy(snapshot, c.cache)
	c.mu.Unlock()
	for status, value := range snapshot {
		ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, value, status)
	}
}
