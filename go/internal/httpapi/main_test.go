package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"testing"

	"go.uber.org/goleak"
)

// TestMain gates BOTH lanes (unit and integration) on goroutine hygiene:
// any goroutine still alive after the package's tests is a failure (T-511
// — the stream-hub LISTEN leak class, converted into CI).
func TestMain(m *testing.M) {
	code := m.Run()
	// Client keep-alives are per-process idle conns, not leaks — close
	// them instead of allowlisting their loops.
	if transport, ok := http.DefaultTransport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
	if code == 0 {
		if err := goleak.Find(
			// pgxpool's background health checker exits asynchronously a
			// beat after Close; goleak.Find already retries with backoff,
			// this entry covers the last-instant scheduling race only.
			goleak.IgnoreTopFunction("github.com/jackc/pgx/v5/pgxpool.(*Pool).backgroundHealthCheck"),
			goleak.IgnoreTopFunction("github.com/jackc/pgx/v5/pgxpool.(*Pool).triggerHealthCheck"),
		); err != nil {
			fmt.Fprintf(os.Stderr, "goleak (httpapi): %v\n", err)
			code = 1
		}
	}
	os.Exit(code)
}
