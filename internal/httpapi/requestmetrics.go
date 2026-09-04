package httpapi

import (
	"bufio"
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/johnny4young/janusly/internal/observability"
)

// The RED series every "is the API slow?" question needs. The pattern label
// is the registered mux pattern (bounded by the route table); requests that
// match no gated route — the SPA catch-all, 404s, the few direct handlers —
// share one "other" label so cardinality never follows the URL.
var (
	metricHTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "janusly_http_requests_total",
		Help: "HTTP requests served by the public listener, by route pattern and status.",
	}, []string{"pattern", "status"})
	metricHTTPDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "janusly_http_request_seconds",
		Help:    "HTTP request duration by route pattern; long-lived streams are excluded.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	}, []string{"pattern"})
)

const otherRoutePattern = "other"

type requestTelemetryKey struct{}

// requestTelemetry is filled in by the gated route wrapper once the mux has
// matched, because the pattern lives on the mux's copy of the request and
// is invisible to middleware outside it.
type requestTelemetry struct {
	pattern string
}

// markRoutePattern records the matched pattern for the telemetry wrapper.
func markRoutePattern(r *http.Request) {
	if telemetry, ok := r.Context().Value(requestTelemetryKey{}).(*requestTelemetry); ok && r.Pattern != "" {
		telemetry.pattern = r.Pattern
	}
}

// statusRecorder captures the status the handler wrote while keeping the
// streaming surfaces (Flush) and connection hijacking intact.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusRecorder) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

func (w *statusRecorder) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hijacker, ok := w.ResponseWriter.(http.Hijacker); ok {
		return hijacker.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// withRequestTelemetry wraps the API mux with the request metrics, one
// server span per request, and one structured access-log line carrying the
// request id the browser headers middleware resolved. Probes stay out of the
// log so a health checker never floods it.
func withRequestTelemetry(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		telemetry := &requestTelemetry{}
		ctx, span := observability.Tracer().Start(
			context.WithValue(r.Context(), requestTelemetryKey{}, telemetry),
			"http.request", trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(semconv.HTTPRequestMethodKey.String(r.Method), semconv.URLPath(r.URL.Path)))
		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r.WithContext(ctx))

		pattern := telemetry.pattern
		if pattern == "" {
			pattern = otherRoutePattern
		}
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		elapsed := time.Since(started)
		metricHTTPRequests.WithLabelValues(pattern, strconv.Itoa(status)).Inc()
		if !strings.Contains(pattern, "/stream") {
			metricHTTPDuration.WithLabelValues(pattern).Observe(elapsed.Seconds())
		}
		span.SetName(pattern)
		span.SetAttributes(semconv.HTTPResponseStatusCode(status), attribute.String("janusly.request_id", requestIDFrom(r)))
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(status))
		}
		span.End()
		if isProbePath(r.URL.Path) {
			return
		}
		logger.Info("http request",
			"method", r.Method, "path", r.URL.Path, "pattern", pattern,
			"status", status, "bytes", recorder.bytes,
			"duration_ms", elapsed.Milliseconds(), "request_id", requestIDFrom(r))
	})
}

func isProbePath(path string) bool {
	return path == "/health" || path == "/readyz"
}
