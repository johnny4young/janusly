package executors

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// Behavior cases against a real server. AllowPrivate is enabled here so the
// loopback test server is reachable — the class checks themselves are
// covered by the SSRF matrix.

func testHTTPExecutor() Func {
	return NewHTTPExecutor(HTTPOptions{AllowPrivate: func() bool { return true }})
}

func execHTTP(t *testing.T, config map[string]any) (map[string]any, error) {
	t.Helper()
	out, err := testHTTPExecutor()(context.Background(), Input{Config: config, Context: map[string]any{}})
	if err != nil {
		return nil, err
	}
	result, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("unexpected output shape: %T", out)
	}
	return result, nil
}

func TestHTTPHappyPathProjectsDeclaredJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"customer":{"id":"c-77"},"total":41.5}`))
	}))
	defer server.Close()

	out, err := execHTTP(t, map[string]any{"url": server.URL})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if out["statusCode"] != float64(200) || out["ok"] != true {
		t.Fatalf("status shape wrong: %v", out)
	}
	jsonValue, ok := out["json"].(map[string]any)
	if !ok || jsonValue["total"] != 41.5 {
		t.Fatalf("declared JSON must project: %v", out)
	}
	if !strings.Contains(out["body"].(string), `"c-77"`) {
		t.Fatal("body string contract must hold alongside json")
	}
}

func TestHTTPJSONProjectionRules(t *testing.T) {
	// Invalid declared JSON is observable but non-fatal; undeclared JSON is
	// never guessed; oversized bodies skip parsing with the exact marker.
	cases := []struct {
		name        string
		contentType string
		body        string
		check       func(t *testing.T, out map[string]any)
	}{
		{"invalid declared json", "application/json", "{broken",
			func(t *testing.T, out map[string]any) {
				if out["jsonParseError"] != true {
					t.Fatalf("expected jsonParseError, got %v", out)
				}
			}},
		{"undeclared json never guessed", "text/plain", `{"looks":"like json"}`,
			func(t *testing.T, out map[string]any) {
				if _, has := out["json"]; has {
					t.Fatal("non-JSON content type must not be guessed")
				}
			}},
		{"structured suffix projects", "application/problem+json", `{"title":"upstream"}`,
			func(t *testing.T, out map[string]any) {
				if out["json"].(map[string]any)["title"] != "upstream" {
					t.Fatalf("+json suffix must project: %v", out)
				}
			}},
		{"oversized declared json skips", "application/json",
			`{"pad":"` + strings.Repeat("x", httpJSONProjectionMax) + `"}`,
			func(t *testing.T, out map[string]any) {
				if out["jsonParseSkipped"] != "body_too_large" {
					t.Fatalf("expected body_too_large skip, got keys %v", out)
				}
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			out, err := execHTTP(t, map[string]any{"url": server.URL})
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			tc.check(t, out)
		})
	}
}

func TestHTTPNonOKStatusFailsTheNodeClassifiably(t *testing.T) {
	// Verified against the contract: a non-2xx response THROWS
	// (HttpResponseError) so retryOn: ["5xx"] policies can match.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	_, err := execHTTP(t, map[string]any{"url": server.URL})
	if err == nil || err.Error() != "HTTP failed: 503" {
		t.Fatalf("message contract mismatch: %v", err)
	}
	var rich *ExecErrorShape
	if !asExecErrorShape(err, &rich) || rich.Name != "HttpResponseError" ||
		rich.Code != "E_HTTP_STATUS" || rich.StatusCode != 503 {
		t.Fatalf("classification identity broken: %+v", rich)
	}
}

func asExecErrorShape(err error, target **ExecErrorShape) bool {
	shape, ok := err.(*ExecErrorShape)
	if ok {
		*target = shape
	}
	return ok
}

func TestHTTPRetryPolicyRecoversAfterServerHeals(t *testing.T) {
	// The acceptance story: two 500s then a 200. Here the executor surfaces
	// classifiable failures; the engine's ladder (tested in engine) drives
	// the retries — this proves the per-call halves line up.
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"healed":true}`))
	}))
	defer server.Close()

	config := map[string]any{"url": server.URL}
	for attempt := 1; attempt <= 2; attempt++ {
		_, err := execHTTP(t, config)
		var rich *ExecErrorShape
		if !asExecErrorShape(err, &rich) || rich.StatusCode != 500 {
			t.Fatalf("attempt %d must fail with 500, got %v", attempt, err)
		}
	}
	out, err := execHTTP(t, config)
	if err != nil || out["json"].(map[string]any)["healed"] != true {
		t.Fatalf("healed attempt must succeed: %v err %v", out, err)
	}
}

func TestHTTPRedirectLimitAndBodyCap(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/loop":
			http.Redirect(w, r, server.URL+"/loop", http.StatusFound)
		case "/big":
			_, _ = w.Write([]byte(strings.Repeat("x", 2048)))
		default:
			_, _ = w.Write([]byte("ok"))
		}
	}))
	defer server.Close()

	_, err := execHTTP(t, map[string]any{"url": server.URL + "/loop", "maxRedirects": float64(2)})
	if err == nil || !strings.Contains(err.Error(), "HTTP redirect limit exceeded") {
		t.Fatalf("redirect loop must exhaust the limit: %v", err)
	}
	_, err = execHTTP(t, map[string]any{"url": server.URL + "/big", "maxResponseBytes": float64(1024)})
	if err == nil || !strings.Contains(err.Error(), "HTTP response exceeds maxResponseBytes") {
		t.Fatalf("body cap must fail the request: %v", err)
	}
}

func TestHTTPMethodHeadersAndBodyReachTheServer(t *testing.T) {
	var seenMethod, seenAuth, seenBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenAuth = r.Header.Get("X-Custom")
		raw := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(raw)
		seenBody = string(raw)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	out, err := execHTTP(t, map[string]any{
		"url": server.URL, "method": "post",
		"headers": map[string]any{"X-Custom": "labeled"},
		"body":    map[string]any{"amount": float64(7)},
	})
	if err != nil || out["statusCode"] != float64(201) {
		t.Fatalf("POST must succeed: %v err %v", out, err)
	}
	if seenMethod != "POST" || seenAuth != "labeled" || seenBody != `{"amount":7}` {
		t.Fatalf("request shape wrong: %s %s %s", seenMethod, seenAuth, seenBody)
	}
	_ = json.Valid([]byte(seenBody))
}

// Cross-origin redirects must not forward credential headers — and the
// definition is the fetch spec's ORIGIN (scheme+host+port), stricter than
// Go's own domain-based stripping: the same host on a DIFFERENT PORT is a
// different origin, and Proxy-Authorization is covered too.
func TestRedirectStripsCredentialsAcrossOrigins(t *testing.T) {
	type seen struct{ auth, proxyAuth, cookie, custom string }
	record := func(into *seen) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			*into = seen{
				auth: r.Header.Get("Authorization"), proxyAuth: r.Header.Get("Proxy-Authorization"),
				cookie: r.Header.Get("Cookie"), custom: r.Header.Get("X-Trace"),
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}

	// Same host (127.0.0.1), different port: cross-origin by fetch rules.
	var crossSeen seen
	crossTarget := httptest.NewServer(record(&crossSeen))
	defer crossTarget.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, crossTarget.URL+"/land", http.StatusFound)
	}))
	defer redirector.Close()

	headers := map[string]any{
		"Authorization":       "Bearer top-secret",
		"Proxy-Authorization": "Basic cHJveHk=",
		"Cookie":              "session=abc",
		"X-Trace":             "keep-me",
	}
	if _, err := execHTTP(t, map[string]any{"url": redirector.URL, "headers": headers}); err != nil {
		t.Fatal(err)
	}
	if crossSeen.auth != "" || crossSeen.proxyAuth != "" || crossSeen.cookie != "" {
		t.Fatalf("credentials leaked across origins: %+v", crossSeen)
	}
	if crossSeen.custom != "keep-me" {
		t.Fatalf("non-credential headers must survive: %+v", crossSeen)
	}

	// Same origin (same server, path redirect): headers are kept.
	var sameSeen seen
	var sameServer *httptest.Server
	sameServer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hop" {
			http.Redirect(w, r, sameServer.URL+"/land", http.StatusFound)
			return
		}
		record(&sameSeen)(w, r)
	}))
	defer sameServer.Close()
	if _, err := execHTTP(t, map[string]any{"url": sameServer.URL + "/hop", "headers": headers}); err != nil {
		t.Fatal(err)
	}
	if sameSeen.auth != "Bearer top-secret" || sameSeen.cookie != "session=abc" {
		t.Fatalf("same-origin redirect must keep credentials: %+v", sameSeen)
	}
}

// Streaming opt-in: bounded preview, full byte accounting, no JSON
// projection, and the response byte cap still aborting mid-stream.
func TestStreamingBodyModeProducesBoundedPreview(t *testing.T) {
	big := strings.Repeat("x", 200_000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(big))
	}))
	defer server.Close()

	out, err := execHTTP(t, map[string]any{
		"url": server.URL, "bodyMode": "stream", "streamPreviewBytes": float64(2048),
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["streamed"] != true || out["streamTruncated"] != true {
		t.Fatalf("stream markers: %+v", out)
	}
	if preview := out["body"].(string); len(preview) != 2048 {
		t.Fatalf("preview cap: %d bytes", len(preview))
	}
	if out["streamedBytes"] != 200_000 {
		t.Fatalf("byte accounting: %v", out["streamedBytes"])
	}
	if _, projected := out["json"]; projected {
		t.Fatalf("streaming previews are never JSON-projected: %+v", out)
	}

	// A small body arrives whole and untruncated.
	small, err := execHTTP(t, map[string]any{"url": server.URL + "/", "bodyMode": "stream",
		"streamPreviewBytes": float64(1_000_000)})
	if err != nil {
		t.Fatal(err)
	}
	if small["streamTruncated"] != false || small["streamedBytes"] != 200_000 {
		t.Fatalf("full preview: %+v", small)
	}

	// The response byte cap still aborts mid-stream with the wire message.
	_, err = execHTTP(t, map[string]any{
		"url": server.URL, "bodyMode": "stream",
		"streamPreviewBytes": float64(2048), "maxResponseBytes": float64(50_000),
	})
	if err == nil || !strings.Contains(err.Error(), "exceeds maxResponseBytes after") {
		t.Fatalf("byte cap must abort the stream: %v", err)
	}

	// Preview cap clamps to the catalog range (below 1024 → 1024).
	clamped, err := execHTTP(t, map[string]any{
		"url": server.URL, "bodyMode": "stream", "streamPreviewBytes": float64(10),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(clamped["body"].(string)) != 1024 {
		t.Fatalf("clamp floor: %d", len(clamped["body"].(string)))
	}
}
