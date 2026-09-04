package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The telemetry wrapper writes one structured line per request carrying the
// request id the browser-headers middleware resolved and the matched route
// pattern; probes never reach the log.
func TestRequestTelemetryLogsPatternAndRequestID(t *testing.T) {
	t.Setenv("JANUSLY_ACCESS_LOG", "all")
	var buffer bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buffer, nil))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/things/{id}", func(w http.ResponseWriter, r *http.Request) {
		markRoutePattern(r)
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("brewing"))
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := WithBrowserHeaders(withRequestTelemetry(mux, logger))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/things/42", nil)
	request.Header.Set("x-request-id", "req-telemetry-1")
	handler.ServeHTTP(recorder, request)

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buffer.Bytes()), &line); err != nil {
		t.Fatalf("access log must be one JSON line: %v (%q)", err, buffer.String())
	}
	if line["msg"] != "http request" || line["pattern"] != "GET /v1/things/{id}" || line["request_id"] != "req-telemetry-1" {
		t.Fatalf("unexpected access line: %v", line)
	}
	if status, _ := line["status"].(float64); int(status) != http.StatusTeapot {
		t.Fatalf("status must be the handler's, got %v", line["status"])
	}
	if bytesWritten, _ := line["bytes"].(float64); int(bytesWritten) != len("brewing") {
		t.Fatalf("bytes must count the body, got %v", line["bytes"])
	}

	buffer.Reset()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/health", nil))
	if strings.TrimSpace(buffer.String()) != "" {
		t.Fatalf("probes must stay out of the access log: %q", buffer.String())
	}

	// A request outside the gated table shares the bounded "other" label.
	buffer.Reset()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/nowhere/"+strings.Repeat("x", 40), nil))
	_ = json.Unmarshal(bytes.TrimSpace(buffer.Bytes()), &line)
	if line["pattern"] != otherRoutePattern {
		t.Fatalf("unmatched routes must not label by path: %v", line["pattern"])
	}
}

func TestAccessLogDefaultKeepsErrorsAndSlowRequestsOnly(t *testing.T) {
	policy := accessLogMode()
	if policy != accessLogErrors {
		t.Fatalf("unset env must default to errors, got %q", policy)
	}
	if policy.logs(http.StatusOK, 20*time.Millisecond) {
		t.Fatal("a fast 200 must not be logged by default")
	}
	if !policy.logs(http.StatusInternalServerError, 0) || !policy.logs(http.StatusForbidden, 0) {
		t.Fatal("errors must always be logged")
	}
	if !policy.logs(http.StatusOK, 2*time.Second) {
		t.Fatal("a slow 200 must be logged")
	}
	t.Setenv("JANUSLY_ACCESS_LOG", "off")
	if accessLogMode().logs(http.StatusInternalServerError, 0) {
		t.Fatal("off must log nothing")
	}
}
