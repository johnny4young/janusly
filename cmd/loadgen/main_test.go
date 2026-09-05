package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestLatencyHistogramIsBoundedAndConservative(t *testing.T) {
	histogram := newLatencyHistogram()
	for _, latency := range []time.Duration{
		100 * time.Microsecond,
		2 * time.Millisecond,
		3 * time.Millisecond,
		4 * time.Millisecond,
		100 * time.Second,
	} {
		histogram.record(latency, false)
	}
	if got := histogram.percentile(0.50); got != 3 {
		t.Fatalf("p50 = %v, want 3ms", got)
	}
	if got := histogram.percentile(0.99); got != maxLatencyMs+1 {
		t.Fatalf("overflow p99 = %v, want %dms", got, maxLatencyMs+1)
	}
	if len(histogram.buckets) != maxLatencyMs+2 {
		t.Fatalf("histogram grew unexpectedly: %d buckets", len(histogram.buckets))
	}
}

func TestValidateBaseRequiresExplicitRemoteOptIn(t *testing.T) {
	for _, local := range []string{"http://127.0.0.1:3001", "http://[::1]:3001", "http://localhost:3001/"} {
		if _, err := validateBase(local, false); err != nil {
			t.Fatalf("local origin %q: %v", local, err)
		}
	}
	if _, err := validateBase("https://janusly.example", false); err == nil {
		t.Fatal("remote origin passed without explicit opt-in")
	}
	if _, err := validateBase("https://janusly.example", true); err != nil {
		t.Fatalf("explicit remote origin: %v", err)
	}
	for _, invalid := range []string{
		"postgres://127.0.0.1/janusly",
		"http://user:pass@127.0.0.1:3001",
		"http://127.0.0.1:3001/api",
		"http://127.0.0.1:3001?x=1",
	} {
		if _, err := validateBase(invalid, true); err == nil {
			t.Fatalf("invalid origin passed: %q", invalid)
		}
	}
}

func TestQueueSnapshotAccountingSeparatesUnavailableFromMalformed(t *testing.T) {
	summary := queueObservabilitySummary{}
	if err := summary.record(map[string]any{"active": float64(3), "waiting": float64(7)}); err != nil {
		t.Fatalf("record measured snapshot: %v", err)
	}
	if summary.ValidSnapshots != 1 || summary.MaxActive != 3 || summary.MaxWaiting != 7 {
		t.Fatalf("measured snapshot evidence = %+v", summary)
	}
	if err := summary.record(map[string]any{"queue": nil}); err != nil {
		t.Fatalf("record explicit unavailable snapshot: %v", err)
	}
	if summary.UnavailableSnapshots != 1 || summary.MaxUnavailableConsecutive != 1 {
		t.Fatalf("unavailable snapshot evidence = %+v", summary)
	}

	for name, snapshot := range map[string]map[string]any{
		"missing":        {},
		"partial":        {"active": float64(0)},
		"negative":       {"active": float64(-1), "waiting": float64(0)},
		"fractional":     {"active": float64(0.5), "waiting": float64(0)},
		"mixed-null":     {"active": float64(0), "waiting": float64(0), "queue": nil},
		"invalid-marker": {"queue": "unavailable"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := (&queueObservabilitySummary{}).record(snapshot); err == nil {
				t.Fatalf("malformed queue snapshot accepted: %#v", snapshot)
			}
		})
	}
	for _, invalid := range []any{"7", nil, float64(-1), 1.5, float64(maximumExactJSONInteger + 1)} {
		if _, ok := nonNegativeJSONInteger(invalid); ok {
			t.Fatalf("invalid JSON count accepted: %#v", invalid)
		}
	}
}

func TestQueueSnapshotAvailabilityRequiresBoundedEvidence(t *testing.T) {
	atLimit := queueObservabilitySummary{
		Probes: 200, ValidSnapshots: 199, UnavailableSnapshots: 1,
		MaxUnavailableConsecutive: queueUnavailableConsecutiveLimit,
	}
	atLimit.finalize()
	if atLimit.Availability != queueSnapshotAvailabilityMinimum || !atLimit.Passed {
		t.Fatalf("exact queue limits must pass: %+v", atLimit)
	}

	for name, summary := range map[string]queueObservabilitySummary{
		"below-availability": {
			Probes: 200, ValidSnapshots: 198, UnavailableSnapshots: 2,
			MaxUnavailableConsecutive: 2,
		},
		"blackout": {
			Probes: 2000, ValidSnapshots: 1993, UnavailableSnapshots: 7,
			MaxUnavailableConsecutive: queueUnavailableConsecutiveLimit + 1,
		},
		"missing": {},
		"inconsistent": {
			Probes: 20, ValidSnapshots: 20, UnavailableSnapshots: 1,
		},
	} {
		t.Run(name, func(t *testing.T) {
			summary.finalize()
			if summary.Passed {
				t.Fatalf("unsafe queue observability passed: %+v", summary)
			}
		})
	}
}

func TestMonitorQueueFailsClosedOnTransportAndMalformedPayloads(t *testing.T) {
	for name, probe := range map[string]func(context.Context) (map[string]any, error){
		"transport": func(context.Context) (map[string]any, error) {
			return nil, errors.New("connection reset")
		},
		"malformed": func(context.Context) (map[string]any, error) { //nolint:unparam // fixture table shares the probe signature
			return map[string]any{"active": float64(0)}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := monitorQueue(context.Background(), time.Millisecond, probe, &queueObservabilitySummary{})
			if err == nil || !strings.Contains(err.Error(), "queue probe during load") {
				t.Fatalf("unsafe probe did not fail closed: %v", err)
			}
		})
	}
}

func TestQueueProbeIntervalIsBounded(t *testing.T) {
	for _, valid := range []time.Duration{0, minimumQueueProbeInterval, time.Second, maximumQueueProbeInterval} {
		if !validQueueProbeInterval(valid) {
			t.Fatalf("valid interval rejected: %s", valid)
		}
	}
	for _, invalid := range []time.Duration{-time.Second, minimumQueueProbeInterval - 1, maximumQueueProbeInterval + 1} {
		if validQueueProbeInterval(invalid) {
			t.Fatalf("invalid interval accepted: %s", invalid)
		}
	}
}
