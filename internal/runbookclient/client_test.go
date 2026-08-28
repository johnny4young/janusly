package runbookclient

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientRequestEnvelopeAndAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/runs" || r.URL.Query().Get("runId") != "run/one" {
			t.Errorf("request target = %s", r.URL.String())
			return
		}
		if r.Header.Get("x-org-id") != "org-one" || r.Header.Get("x-user-id") != "operator" {
			t.Errorf("development headers = %+v", r.Header)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("unexpected authorization header")
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != `{"ok":true}` {
			t.Errorf("body = %q", raw)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"accepted":true}`)
	}))
	defer server.Close()

	client := newTestClient(t, Config{BaseURL: server.URL, OrgID: "org-one", UserID: "operator"})
	status, decoded, err := client.DoJSON(context.Background(), http.MethodPost, "/runs?runId=run%2Fone", map[string]any{"ok": true})
	if err != nil || status != http.StatusAccepted || decoded["accepted"] != true {
		t.Fatalf("response = %d %+v, err=%v", status, decoded, err)
	}
}

func TestBearerTokenSuppressesDevelopmentIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer service-token" || r.Header.Get("x-user-id") != "" {
			t.Errorf("authentication headers = %+v", r.Header)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	client := newTestClient(t, Config{BaseURL: server.URL, UserID: "ignored", BearerToken: "service-token"})
	if _, _, err := client.DoJSON(context.Background(), http.MethodGet, "/health", nil); err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsUnsafeOrInvalidResponses(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "empty", body: " ", want: "response is empty"},
		{name: "malformed", body: "{", want: "decode API response"},
		{name: "non object", body: "[]", want: "cannot unmarshal array"},
		{name: "oversized", body: strings.Repeat("x", int(MaxResponseBytes)+1), want: "response exceeds"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()
			client := newTestClient(t, Config{BaseURL: server.URL})
			_, _, err := client.DoJSON(context.Background(), http.MethodGet, "/x", nil)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestClientTimeoutAndRedirectBoundary(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(100 * time.Millisecond)
			_, _ = io.WriteString(w, `{}`)
		}))
		defer server.Close()
		client := newTestClient(t, Config{BaseURL: server.URL, Timeout: 10 * time.Millisecond})
		_, _, err := client.DoJSON(context.Background(), http.MethodGet, "/slow", nil)
		if err == nil || !strings.Contains(err.Error(), "context deadline exceeded") {
			t.Fatalf("timeout error = %v", err)
		}
	})

	t.Run("cross origin redirect", func(t *testing.T) {
		destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("cross-origin destination was reached")
		}))
		defer destination.Close()
		source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, destination.URL, http.StatusFound)
		}))
		defer source.Close()
		client := newTestClient(t, Config{BaseURL: source.URL})
		_, _, err := client.DoJSON(context.Background(), http.MethodGet, "/redirect", nil)
		if err == nil || !strings.Contains(err.Error(), "cross-origin") {
			t.Fatalf("redirect error = %v", err)
		}
	})
}

func TestClientRejectsInvalidConfigurationAndInput(t *testing.T) {
	for _, baseURL := range []string{"", "ftp://example.com", "https://user:pass@example.com", "https://example.com/api"} {
		t.Run(fmt.Sprintf("base %q", baseURL), func(t *testing.T) {
			if _, err := New(Config{BaseURL: baseURL}); err == nil {
				t.Fatalf("accepted base URL %q", baseURL)
			}
		})
	}
	client := newTestClient(t, Config{BaseURL: "http://example.com"})
	if _, _, err := client.DoJSON(context.Background(), http.MethodGet, "https://evil.example", nil); err == nil {
		t.Fatal("accepted absolute request URL")
	}
	if _, _, err := client.DoJSON(context.Background(), http.MethodPost, "/x", map[string]any{"bad": make(chan int)}); err == nil {
		t.Fatal("accepted unencodable request body")
	}
}

func newTestClient(t *testing.T, cfg Config) *Client {
	t.Helper()
	client, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
