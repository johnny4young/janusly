//go:build integration

package engine

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/johnny4young/janusly/internal/observability"
)

// sweepSamples reads the two series the stale-pass alert depends on.
func sweepSamples(t *testing.T, sweep string) (failures float64, lastSuccess float64, hasSuccess bool) {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	pick := func(name string) (float64, bool) {
		for _, family := range families {
			if family.GetName() != name {
				continue
			}
			for _, metric := range family.GetMetric() {
				for _, label := range metric.GetLabel() {
					if label.GetName() == "sweep" && label.GetValue() == sweep {
						switch family.GetType() {
						case dto.MetricType_COUNTER:
							return metric.GetCounter().GetValue(), true
						case dto.MetricType_GAUGE:
							return metric.GetGauge().GetValue(), true
						}
					}
				}
			}
		}
		return 0, false
	}
	failures, _ = pick("janusly_sweep_failures_total")
	lastSuccess, hasSuccess = pick("janusly_sweep_last_success_timestamp_seconds")
	return failures, lastSuccess, hasSuccess
}

// A sweep whose one infrastructure dependency is gone must report it: the
// failure counter moves and liveness does NOT advance. Before this test the
// loops passed a literal nil and a scheduler cut off from PostgreSQL looked
// freshly healthy forever.
func TestSweepsReportInfrastructureFailureToTelemetry(t *testing.T) {
	ctx, pool, eng, _ := newHarness(t)
	quiet := slog.New(slog.DiscardHandler)
	pool.Close()

	passes := []struct {
		sweep string
		run   func() error
	}{
		{observability.SweepSchedule, func() error { _, _, err := eng.SweepDueSchedules(ctx); return err }},
		{observability.SweepStalledNodeReaper, func() error { _, err := eng.ReapStalledNodes(ctx, 0, 50, quiet); return err }},
		{observability.SweepSubworkflowReconciler, func() error { _, _, err := eng.ReconcileSubworkflowTerminals(ctx); return err }},
		{observability.SweepMemoryConsentPurge, func() error { _, err := eng.SweepMemoryConsentPurges(ctx); return err }},
		{observability.SweepAutoHealing, func() error {
			t.Setenv("JANUSLY_AUTO_HEALING_ENABLED", "true")
			return eng.SweepAutoHealing(ctx).Err
		}},
	}
	for _, pass := range passes {
		t.Run(pass.sweep, func(t *testing.T) {
			failuresBefore, successBefore, hadSuccess := sweepSamples(t, pass.sweep)
			started := time.Now()
			err := pass.run()
			if err == nil || !strings.Contains(err.Error(), "closed pool") {
				t.Fatalf("sweep must surface the closed pool, got %v", err)
			}
			observability.ObserveSweepPass(pass.sweep, started, err)
			failuresAfter, successAfter, hasSuccess := sweepSamples(t, pass.sweep)
			if failuresAfter != failuresBefore+1 {
				t.Fatalf("failures %v -> %v, want +1", failuresBefore, failuresAfter)
			}
			if hasSuccess != hadSuccess || successAfter != successBefore {
				t.Fatalf("liveness must not advance on a failed pass (%v/%v -> %v/%v)", hadSuccess, successBefore, hasSuccess, successAfter)
			}
		})
	}
}
