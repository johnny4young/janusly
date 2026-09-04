package executors

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// Outbound calls used to build a transport per request with keep-alives
// disabled, so every node paid a TCP (and TLS) handshake. The shared pinned
// transport reuses connections while still dialing only through the pins
// the request validated.
func TestSharedOutboundTransportReusesConnections(t *testing.T) {
	var opened atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			opened.Add(1)
		}
	}
	server.Start()
	defer server.Close()

	// The open posture shares the same pool shape; the pinned dialer refuses
	// loopback by design, so reuse is observed here and the pin routing
	// below.
	client := &http.Client{Transport: sharedOpenTransport()}
	for range 3 {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
		res, err := client.Do(req)
		if err != nil {
			t.Fatalf("pinned request: %v", err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}
	if got := opened.Load(); got != 1 {
		t.Fatalf("three sequential requests must share one connection, opened %d", got)
	}
}

func TestSharedPinnedTransportDialsOnlyThroughRequestPins(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the server must never be reached")
	}))
	defer server.Close()
	client := &http.Client{Transport: sharedPinnedTransport()}

	// No pins on the context: the shared dialer fails closed.
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	res, err := client.Do(req)
	if err == nil {
		_ = res.Body.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "without a validated pin") {
		t.Fatalf("want a fail-closed dial error, got %v", err)
	}

	// Pins on the context: the dial goes through them, and the pinned
	// dialer's own private-address check is what rejects loopback here.
	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	pins.pin("127.0.0.1", net.ParseIP("127.0.0.1"))
	req, _ = http.NewRequestWithContext(withPins(context.Background(), pins), http.MethodGet, server.URL, nil)
	res, err = client.Do(req)
	if err == nil {
		_ = res.Body.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "private and blocked") {
		t.Fatalf("the shared transport must route the dial through the request pins, got %v", err)
	}
}
