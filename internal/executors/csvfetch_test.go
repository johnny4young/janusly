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

	// Pre-stream rejection (unsupported scheme): statusCode 0, not truncated.
	pre := csvFetch(t, map[string]any{"url": "ftp://example.com/x.csv"})
	if pre["ok"] != false || pre["statusCode"] != 0 || pre["streamTruncated"] != false {
		t.Fatalf("pre-stream envelope: %+v", pre)
	}

	// Out-of-range bounds are validation errors, not envelopes.
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	_, err := NewToolRegistry().Execute(context.Background(), "csv.fetch",
		map[string]any{"url": big.URL, "sampleRows": float64(501)})
	if err == nil || !strings.Contains(err.Error(), "sampleRows") {
		t.Fatalf("bounds validation: %v", err)
	}
}
