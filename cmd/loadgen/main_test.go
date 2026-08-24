package main

import (
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
