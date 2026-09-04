//go:build integration

package httpapi

import (
	"net/http"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// After a gated call, the RED series carry the route pattern the mux matched
// and the status the handler wrote — the labels the dashboard's latency and
// error panels group by.
func TestGatedRoutesCountUnderTheirPattern(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	before := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("GET /v1/recovery/metrics", "200"))
	if res := h.call("GET", "/v1/recovery/metrics", nil, ""); res.status != http.StatusOK {
		t.Fatalf("want 200, got %d: %v", res.status, res.body)
	}
	if after := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("GET /v1/recovery/metrics", "200")); after != before+1 {
		t.Fatalf("the gated route must count under its pattern: %v -> %v", before, after)
	}
	if got := testutil.CollectAndCount(metricHTTPDuration, "janusly_http_request_seconds"); got == 0 {
		t.Fatal("request durations must be observed")
	}
}
