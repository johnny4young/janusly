package observability

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestSweepCatalogIsClosedDistinctAndPreinitialized(t *testing.T) {
	names := SweepNames()
	want := []string{
		SweepRetention, SweepSchedule, SweepStalledNodeReaper,
		SweepSubworkflowReconciler, SweepAutoHealing,
		SweepMemoryConsentPurge, SweepRunSummaryMemory,
		SweepUpstreamHealth, SweepReplayCampaignPump,
	}
	if !slices.Equal(names, want) {
		t.Fatalf("sweep catalog = %v, want %v", names, want)
	}
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		if name == "" || seen[name] {
			t.Fatalf("invalid sweep catalog entry %q", name)
		}
		seen[name] = true
		if got := testutil.ToFloat64(metricSweepFailures.WithLabelValues(name)); got != 0 {
			t.Fatalf("initial failures for %q = %v, want 0", name, got)
		}
	}
}

func TestObserveSweepPassSeparatesLivenessFromFailure(t *testing.T) {
	const sweep = SweepReplayCampaignPump
	metricSweepPass.DeleteLabelValues(sweep)
	metricSweepLastSuccess.DeleteLabelValues(sweep)
	metricSweepFailures.DeleteLabelValues(sweep)
	t.Cleanup(func() {
		metricSweepPass.DeleteLabelValues(sweep)
		metricSweepLastSuccess.DeleteLabelValues(sweep)
		metricSweepFailures.DeleteLabelValues(sweep)
		metricSweepFailures.WithLabelValues(sweep).Add(0)
	})

	ObserveSweepPass(sweep, time.Now().Add(-time.Millisecond), nil)
	stamp := testutil.ToFloat64(metricSweepLastSuccess.WithLabelValues(sweep))
	if stamp <= float64(time.Now().Add(-time.Minute).Unix()) {
		t.Fatalf("successful pass did not stamp liveness: %v", stamp)
	}

	ObserveSweepPass(sweep, time.Now(), errors.New("query timeout"))
	if got := testutil.ToFloat64(metricSweepFailures.WithLabelValues(sweep)); got != 1 {
		t.Fatalf("failure count = %v, want 1", got)
	}
	if got := testutil.ToFloat64(metricSweepLastSuccess.WithLabelValues(sweep)); got != stamp {
		t.Fatalf("failed pass advanced liveness from %v to %v", stamp, got)
	}
	if got := testutil.CollectAndCount(metricSweepPass, "janusly_sweep_pass_seconds"); got == 0 {
		t.Fatal("pass duration histogram was not materialized")
	}
}

func TestObserveSweepPassRejectsUnboundedLabels(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("unregistered sweep label did not panic")
		}
	}()
	ObserveSweepPass("tenant-controlled-label", time.Now(), nil)
}
