package executors

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func csvFetch(t *testing.T, input map[string]any) map[string]any {
	t.Helper()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	out, err := NewToolRegistry().Execute(context.Background(), "csv.fetch", input)
	if err != nil {
		t.Fatalf("csv.fetch: %v", err)
	}
	return out
}

func TestCsvFetchBoundedSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, "id,status\n")
		for i := range 1000 {
			status := "open"
			if i%4 == 0 {
				status = "done"
			}
			_, _ = fmt.Fprintf(w, "%d,%s\n", i, status)
		}
		_, _ = fmt.Fprint(w, "malformed-row-with-one-column\n")
	}))
	defer server.Close()

	out := csvFetch(t, map[string]any{
		"url": server.URL, "sampleRows": float64(5),
		"filter": map[string]any{"status": "open"},
	})
	if out["ok"] != true || out["statusCode"] != 200 {
		t.Fatalf("envelope: %+v", out)
	}
	if out["totalRows"] != 1001 || out["matchedRows"] != 750 || out["malformedRows"] != 1 {
		t.Fatalf("counts: total=%v matched=%v malformed=%v", out["totalRows"], out["matchedRows"], out["malformedRows"])
	}
	sample := out["sampleRows"].([]any)
	if len(sample) != 5 || sample[0].(map[string]any)["status"] != "open" {
		t.Fatalf("sample: %+v", sample)
	}
	headers := out["headers"].([]any)
	if len(headers) != 2 || headers[0] != "id" {
		t.Fatalf("headers: %+v", headers)
	}
}

func TestCsvFetchFailurePaths(t *testing.T) {
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Transfer-Encoding", "chunked") // no Content-Length pre-check
		for i := range 100_000 {
			_, _ = fmt.Fprintf(w, "%d,x\n", i)
		}
	}))
	defer big.Close()

	// Mid-stream byte-cap abort: partial counts + truncated marker.
	capped := csvFetch(t, map[string]any{"url": big.URL, "maxBytes": float64(16384)})
	if capped["ok"] != false || capped["streamTruncated"] != true {
		t.Fatalf("cap envelope: %+v", capped)
	}
	if capped["totalRows"].(int) == 0 || !strings.Contains(capped["error"].(string), "exceeds maxResponseBytes") {
		t.Fatalf("partial accounting: %+v", capped)
	}

	// Non-2xx still streams the (CSV-shaped) error body.
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = fmt.Fprint(w, "error,detail\nupstream,down\n")
	}))
	defer failing.Close()
	bad := csvFetch(t, map[string]any{"url": failing.URL})
	if bad["ok"] != false || bad["statusCode"] != 502 || bad["totalRows"] != 1 || bad["error"] != "HTTP 502" {
		t.Fatalf("non-2xx envelope: %+v", bad)
	}

	// A literal unsupported scheme is rejected by the shared authoring/runtime
	// contract before a network envelope can be mistaken for a provider call.
	_, preErr := NewToolRegistry().Execute(context.Background(), "csv.fetch", map[string]any{
		"url": "ftp://example.com/x.csv",
	})
	if preErr == nil || !strings.Contains(preErr.Error(), "absolute HTTP(S)") {
		t.Fatalf("unsupported scheme validation: %v", preErr)
	}

	// Out-of-range bounds are validation errors, not envelopes.
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	_, err := NewToolRegistry().Execute(context.Background(), "csv.fetch",
		map[string]any{"url": big.URL, "sampleRows": float64(501)})
	if err == nil || !strings.Contains(err.Error(), "sampleRows") {
		t.Fatalf("bounds validation: %v", err)
	}

	malformed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Transfer-Encoding", "chunked")
		_, _ = fmt.Fprint(w, "id,status\n1,open\n2,\"unterminated")
	}))
	t.Cleanup(malformed.Close)
	decoded := csvFetch(t, map[string]any{"url": malformed.URL})
	if decoded["ok"] != false || decoded["streamTruncated"] != true ||
		!strings.Contains(decoded["error"].(string), "unterminated quoted field") || decoded["totalRows"] != 1 {
		t.Fatalf("stream grammar failure must retain bounded partial evidence: %+v", decoded)
	}
}

func TestCsvFetchDefinitionValidatesPersistedAndResolvedInputs(t *testing.T) {
	registry := NewToolRegistry()
	for _, test := range []struct {
		name  string
		input map[string]any
		want  string
	}{
		{
			name:  "blank URL",
			input: map[string]any{"url": "   "},
			want:  "url must be a non-empty string",
		},
		{
			name:  "fractional sample",
			input: map[string]any{"url": "https://example.com/data.csv", "sampleRows": 1.5},
			want:  "sampleRows must be an integer",
		},
		{
			name:  "non-string header",
			input: map[string]any{"url": "https://example.com/data.csv", "headers": map[string]any{"X-Count": true}},
			want:  `http.headers["X-Count"] must be a string`,
		},
		{
			name:  "header injection",
			input: map[string]any{"url": "https://example.com/data.csv", "headers": map[string]any{"X-Trace": "ok\r\nevil"}},
			want:  "valid bounded HTTP names and values",
		},
		{
			name:  "non-string filter",
			input: map[string]any{"url": "https://example.com/data.csv", "filter": map[string]any{"status": true}},
			want:  "string values",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := registry.ValidateInput("csv.fetch", test.input); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validation = %v, want %q", err, test.want)
			}
		})
	}

	templated := map[string]any{
		"url": "{{context.input.url}}", "sampleRows": "{{context.policy.output.sampleRows}}",
	}
	if err := registry.ValidateInput("csv.fetch", templated); err != nil {
		t.Fatalf("save-time template references rejected: %v", err)
	}
	if err := registry.ValidateResolvedInput("csv.fetch", templated); err == nil || !strings.Contains(err.Error(), "sampleRows: Expected number") {
		t.Fatalf("unresolved runtime input accepted: %v", err)
	}
}

func TestCsvFetchAcceptsSafeInternalIntegerBounds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, "id,status\n1,open\n2,closed\n")
	}))
	t.Cleanup(server.Close)

	out := csvFetch(t, map[string]any{
		"url": server.URL, "sampleRows": 1, "maxBytes": int64(4096),
		"timeoutMs": uint32(2_000), "maxRedirects": 0,
	})
	if out["ok"] != true || len(out["sampleRows"].([]any)) != 1 {
		t.Fatalf("safe integer representations drifted: %+v", out)
	}
}

func TestCsvStreamRejectsAmbiguousHeader(t *testing.T) {
	summary := streamCsvSummary(strings.NewReader("id,id\n1,2\n"), 10, 1024, nil)
	if summary.ok || !summary.truncated || !strings.Contains(summary.err, "unique") || summary.totalRows != 0 {
		t.Fatalf("duplicate headers must fail before row projection: %+v", summary)
	}
}
