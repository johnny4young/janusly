// Engine metrics on the default Prometheus registry, served by the internal
// port's /metrics. Counter names carry the pilot's own janusly_go_ prefix —
// they are new series, not impostors of the reference's exporters. Queue
// depth is a custom collector with a short cache so scrapes stay bounded and
// can never stampede the database.
package engine

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	metricClaims = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_go_claims_total",
		Help: "Queue claims consumed by the worker pool.",
	})
	metricNodeCompletions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "janusly_go_node_completions_total",
		Help: "Terminal node transitions by outcome.",
	}, []string{"outcome"})
	metricNodeRetries = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_go_node_retries_total",
		Help: "Retry requeues scheduled by the failure ladder.",
	})
	metricRunsTerminal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "janusly_go_runs_terminal_total",
		Help: "Run-level terminal transitions by status.",
	}, []string{"status"})
	metricReapedNodes = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_go_reaped_nodes_total",
		Help: "Stalled running nodes failed into the DLQ by the reaper.",
	})
	metricRedrives = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_go_redrives_total",
		Help: "Dead letters successfully redriven.",
	})
	metricNodeExecution = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "janusly_go_node_execution_seconds",
		Help:    "Executor wall time per claimed node.",
		Buckets: prometheus.ExponentialBuckets(0.001, 2.5, 12),
	})
)

// QueueDepthCollector exposes janusly_go_queue_depth{state} from one bounded
// GROUP BY, cached briefly so concurrent scrapes coalesce.
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
		desc: prometheus.NewDesc("janusly_go_queue_depth",
			"Open run-node rows by state.", []string{"state"}, nil),
	}
}

// Describe implements prometheus.Collector.
func (c *QueueDepthCollector) Describe(ch chan<- *prometheus.Desc) { ch <- c.desc }

// Collect implements prometheus.Collector with a 5-second cache.
func (c *QueueDepthCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) > 5*time.Second {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		rows, err := c.pool.Query(ctx,
			`SELECT status, count(*) FROM run_nodes
			 WHERE status IN ('pending','queued','running','waiting')
			 GROUP BY status`)
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
			c.cache, c.at = fresh, time.Now()
		}
	}
	for state, value := range c.cache {
		ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, value, state)
	}
}
