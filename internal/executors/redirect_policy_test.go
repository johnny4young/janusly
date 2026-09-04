package executors

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// The redirect posture is one function shared by the http node, fetch, and
// csv fetch. Exercising it directly proves every client gets the same
// budget, the same per-hop re-pin, and the same credential stripping — a
// divergence between copies used to be a silent security regression.
func TestRedirectPolicyIsOneSharedPosture(t *testing.T) {
	executor := &httpExecutor{opts: HTTPOptions{Resolve: staticResolver("93.184.216.34"), AllowPrivate: denyAll()}}
	pins := &pinnedDialer{byHost: map[string]net.IP{}}

	hop := func(raw string) *http.Request {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		req := &http.Request{URL: u, Header: http.Header{}}
		return req.WithContext(context.Background())
	}
	origin := hop("https://origin.example/start")
	origin.Header.Set("Authorization", "Bearer top-secret")

	t.Run("hop budget", func(t *testing.T) {
		policy := executor.redirectPolicy(pins, 1, false)
		err := policy(hop("https://origin.example/two"), []*http.Request{origin, origin})
		if err == nil || !strings.Contains(err.Error(), "redirect limit exceeded") {
			t.Fatalf("second hop over a budget of one must fail, got %v", err)
		}
	})

	t.Run("every hop revalidates against the pinned dialer", func(t *testing.T) {
		metadata := &httpExecutor{opts: HTTPOptions{Resolve: staticResolver("169.254.169.254"), AllowPrivate: denyAll()}}
		policy := metadata.redirectPolicy(pins, 5, false)
		err := policy(hop("http://metadata.example/latest"), []*http.Request{origin})
		if err == nil || !strings.Contains(err.Error(), "private address and is blocked") {
			t.Fatalf("a hop to a link-local target must die in the policy, got %v", err)
		}
	})

	t.Run("cross-origin hop strips credentials, same-origin keeps them", func(t *testing.T) {
		policy := executor.redirectPolicy(pins, 5, false)
		for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
			cross := hop("https://origin.example:8443/land")
			cross.Header.Set(name, "secret")
			if err := policy(cross, []*http.Request{origin}); err != nil {
				t.Fatal(err)
			}
			if cross.Header.Get(name) != "" {
				t.Fatalf("%s must not survive a cross-origin (port) hop", name)
			}
		}
		same := hop("https://origin.example/land")
		same.Header.Set("Authorization", "Bearer keep")
		if err := policy(same, []*http.Request{origin}); err != nil {
			t.Fatal(err)
		}
		if same.Header.Get("Authorization") != "Bearer keep" {
			t.Fatal("same-origin hop must keep Authorization")
		}
	})

	t.Run("disabled redirects hand the first response back", func(t *testing.T) {
		policy := executor.redirectPolicy(pins, 5, true)
		if err := policy(hop("https://origin.example/land"), []*http.Request{origin}); !errors.Is(err, http.ErrUseLastResponse) {
			t.Fatalf("want ErrUseLastResponse, got %v", err)
		}
	})
}
