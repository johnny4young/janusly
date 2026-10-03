package observability

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr/funcr"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
)

func TestOTLPExporterLogProjectionOmitsEndpoint(t *testing.T) {
	// No connection is started. Exercise the logger's recursive MarshalLog
	// projection, which previously included private exporter endpoint identity.
	const privateEndpoint = "private-export-endpoint.test:4318"
	exporter := otlptracehttp.NewUnstarted(otlptracehttp.WithEndpoint(privateEndpoint))
	var output string
	logger := funcr.NewJSON(func(line string) { output += line }, funcr.Options{})
	logger.Info("configured exporter", "exporter", exporter)
	if output == "" || strings.Contains(output, privateEndpoint) {
		t.Fatal("exporter log projection exposed endpoint configuration")
	}
}

func TestInitTracingPreservesOTLPEnvironmentPaths(t *testing.T) {
	for _, tc := range []struct{ name, signalPath, expected string }{
		{"general base appends traces", "", "/v1/traces"},
		{"signal path remains exact", "/custom/traces", "/custom/traces"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			paths := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths <- r.URL.Path
				w.Header().Set("Content-Type", "application/x-protobuf")
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			t.Setenv("OTEL_EXPORTER", "otlp")
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", server.URL)
			t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "")
			t.Setenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "")
			t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
			if tc.signalPath != "" {
				t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", server.URL+tc.signalPath)
			}
			previous := otel.GetTracerProvider()
			defer otel.SetTracerProvider(previous)
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			shutdown, err := InitTracing(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = shutdown(ctx) }()
			_, span := Tracer().Start(ctx, "compatibility-probe")
			span.End()
			if err := shutdown(ctx); err != nil {
				t.Fatalf("trace export failed: %v", err)
			}
			select {
			case got := <-paths:
				if got != tc.expected {
					t.Fatalf("endpoint path changed: got %s want %s", got, tc.expected)
				}
			case <-ctx.Done():
				t.Fatal("trace was not exported")
			}
		})
	}
}
