//go:build integration

package httpapi

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The per-IP buckets are keyed by the caller address, which every harness
// shares (loopback), so a test owns its window for the duration of the run.
func resetRateWindow(t *testing.T, name string) {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("JANUSLY_DATABASE_URL"))
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	clear := func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM rate_limit_windows WHERE name = $1`, name)
	}
	clear()
	t.Cleanup(func() { clear(); pool.Close() })
}

func countRows(t *testing.T, table string) int64 {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("JANUSLY_DATABASE_URL"))
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	defer pool.Close()
	var n int64
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// The SSO start route used to write a state nonce per request with no bound;
// an unauthenticated caller could fill the table. The bucket now trips before
// the handler touches storage.
func TestSsoStartIsRateLimitedPerIP(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	resetRateWindow(t, ssoStartLimit.Name)
	path := "/auth/sso/start?orgId=" + h.org
	for i := 0; i < ssoStartLimit.Max; i++ {
		res, _ := h.rawGet(t, path)
		if res.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("request %d tripped the limit early", i+1)
		}
	}
	before := countRows(t, "sso_state_nonces")
	res, body := h.rawGet(t, path)
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("request %d: want 429, got %d: %s", ssoStartLimit.Max+1, res.StatusCode, body)
	}
	if after := countRows(t, "sso_state_nonces"); after != before {
		t.Fatalf("limited request must not write a nonce: %d -> %d", before, after)
	}
}

// Starting runs is the most expensive write on the API; the org bucket trips
// before the request body is even parsed, so a flood of malformed starts
// costs one counter bump each.
func TestStartRunIsRateLimitedPerOrg(t *testing.T) {
	const perMinute = 5
	options := DefaultV1ServerOptions()
	options.StartRateLimitPerMinute = perMinute
	h := newAPIHarnessWithOptions(t, false, options)
	for i := 0; i < perMinute; i++ {
		res := h.call("POST", "/v1/start", map[string]any{}, "")
		if res.status == http.StatusTooManyRequests {
			t.Fatalf("request %d tripped the limit early", i+1)
		}
	}
	res := h.call("POST", "/v1/start", map[string]any{}, "")
	if res.status != http.StatusTooManyRequests {
		t.Fatalf("request %d: want 429, got %d: %v", perMinute+1, res.status, res.body)
	}
	if got := res.headers.Get("Retry-After"); got == "" {
		t.Fatal("a limited start must tell the client when to retry")
	}
}

// The public status page is unauthenticated; the IP bucket keeps a token
// scan from turning into three queries per request forever.
func TestPublicStatusPageIsRateLimitedPerIP(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	resetRateWindow(t, publicStatusPageLimit.Name)
	path := "/public/status/" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for i := 0; i < publicStatusPageLimit.Max; i++ {
		res, _ := h.rawGet(t, path)
		if res.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("request %d tripped the limit early", i+1)
		}
	}
	res, _ := h.rawGet(t, path)
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("request %d: want 429, got %d", publicStatusPageLimit.Max+1, res.StatusCode)
	}
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("a limited public read must carry Retry-After")
	}
}
