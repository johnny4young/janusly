package boot

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// PoolStatsCollector exposes pgxpool.Stat for one pool: how many
// connections are acquired, idle, being constructed and allowed, and how
// often an acquire found the pool empty or was cancelled — the numbers that
// say whether a latency cliff is the database or the pool size.
type PoolStatsCollector struct {
	pool        *pgxpool.Pool
	connections *prometheus.Desc
	acquires    *prometheus.Desc
	waitSeconds *prometheus.Desc
}

// NewPoolStatsCollector builds (but does not register) the collector for
// the pool named `name` (api, worker).
func NewPoolStatsCollector(name string, pool *pgxpool.Pool) *PoolStatsCollector {
	labels := prometheus.Labels{"pool": name}
	return &PoolStatsCollector{
		pool: pool,
		connections: prometheus.NewDesc("janusly_db_pool_connections",
			"PostgreSQL pool connections by state.", []string{"state"}, labels),
		acquires: prometheus.NewDesc("janusly_db_pool_acquires_total",
			"Pool acquires by outcome since process start.", []string{"outcome"}, labels),
		waitSeconds: prometheus.NewDesc("janusly_db_pool_acquire_wait_seconds_total",
			"Seconds callers spent waiting for a pool connection since process start.", nil, labels),
	}
}

// Describe implements prometheus.Collector.
func (c *PoolStatsCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.connections
	ch <- c.acquires
	ch <- c.waitSeconds
}

// Collect implements prometheus.Collector from the pool's own counters; no
// query runs.
func (c *PoolStatsCollector) Collect(ch chan<- prometheus.Metric) {
	stat := c.pool.Stat()
	for state, value := range map[string]int32{
		"acquired": stat.AcquiredConns(), "idle": stat.IdleConns(),
		"constructing": stat.ConstructingConns(), "max": stat.MaxConns(),
	} {
		ch <- prometheus.MustNewConstMetric(c.connections, prometheus.GaugeValue, float64(value), state)
	}
	for outcome, value := range map[string]int64{
		"total": stat.AcquireCount(), "empty": stat.EmptyAcquireCount(), "cancelled": stat.CanceledAcquireCount(),
	} {
		ch <- prometheus.MustNewConstMetric(c.acquires, prometheus.CounterValue, float64(value), outcome)
	}
	ch <- prometheus.MustNewConstMetric(c.waitSeconds, prometheus.CounterValue, stat.AcquireDuration().Seconds())
}
