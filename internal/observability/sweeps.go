// Background-loop liveness belongs in observability rather than engine:
// Janusly's supervised maintenance loops span engine and upstream packages.
// Keeping one closed label catalog makes a missing loop visible instead of
// silently creating a second metric spelling that no alert watches.
package observability

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	SweepRetention             = "retention"
	SweepSchedule              = "schedule-sweep"
	SweepStalledNodeReaper     = "stalled-node-reaper"
	SweepSubworkflowReconciler = "subworkflow-terminal-reconciler"
	SweepAutoHealing           = "auto-healing"
	SweepMemoryConsentPurge    = "memory-consent-purge"
	SweepRunSummaryMemory      = "run-summary-memory"
	SweepUpstreamHealth        = "upstream-health"
	SweepReplayCampaignPump    = "replay-campaign-pump"
)

var sweepNames = [...]string{
	SweepRetention,
	SweepSchedule,
	SweepStalledNodeReaper,
	SweepSubworkflowReconciler,
	SweepAutoHealing,
	SweepMemoryConsentPurge,
	SweepRunSummaryMemory,
	SweepUpstreamHealth,
	SweepReplayCampaignPump,
}

var (
	metricSweepPass = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "janusly_sweep_pass_seconds",
		Help:    "Wall time of one completed background-loop pass.",
		Buckets: prometheus.ExponentialBuckets(0.001, 3, 12),
	}, []string{"sweep"})
	metricSweepLastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "janusly_sweep_last_success_timestamp_seconds",
		Help: "Unix time of the last background-loop pass that completed without error.",
	}, []string{"sweep"})
	metricSweepFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "janusly_sweep_failures_total",
		Help: "Background-loop passes that completed with an error.",
	}, []string{"sweep"})
)

// A CounterVec with no materialized labels exposes no metric family at all.
// Publish zero failures for the closed catalog so an alert can distinguish
// "healthy so far" from "the executable does not contain this metric". The
// liveness gauge intentionally stays absent until a loop succeeds: absence is
// the never-ran signal after the process-uptime grace period.
func init() {
	for _, sweep := range sweepNames {
		metricSweepFailures.WithLabelValues(sweep).Add(0)
	}
}

// SweepNames returns the complete supervised maintenance catalog. Callers get
// a copy so the alert cardinality contract cannot be mutated at runtime.
func SweepNames() []string {
	return append([]string(nil), sweepNames[:]...)
}

// ObserveSweepPass records one whole iteration. A failed pass advances its
// duration and failure counter but not liveness; otherwise a loop returning an
// error forever would look healthy to the stale-pass alert.
func ObserveSweepPass(sweep string, started time.Time, err error) {
	known := false
	for _, candidate := range sweepNames {
		if candidate == sweep {
			known = true
			break
		}
	}
	if !known {
		panic("observability: unregistered sweep label " + sweep)
	}
	duration := time.Since(started).Seconds()
	metricSweepPass.WithLabelValues(sweep).Observe(max(duration, 0))
	if err != nil {
		metricSweepFailures.WithLabelValues(sweep).Inc()
		return
	}
	metricSweepLastSuccess.WithLabelValues(sweep).Set(float64(time.Now().Unix()))
}
