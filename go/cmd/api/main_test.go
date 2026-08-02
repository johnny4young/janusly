package main

import (
	"net/http"
	"testing"
)

func TestNewHTTPServerUsesBoundedListenerPolicy(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	server := newHTTPServer("127.0.0.1:0", handler)

	if server.Addr != "127.0.0.1:0" || server.Handler == nil {
		t.Fatalf("server identity: addr=%q handler=%v", server.Addr, server.Handler)
	}
	if server.ReadHeaderTimeout != serverReadHeaderTimeout {
		t.Fatalf("ReadHeaderTimeout = %s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != serverReadTimeout {
		t.Fatalf("ReadTimeout = %s", server.ReadTimeout)
	}
	if server.IdleTimeout != serverIdleTimeout {
		t.Fatalf("IdleTimeout = %s", server.IdleTimeout)
	}
	if server.MaxHeaderBytes != serverMaxHeaderBytes {
		t.Fatalf("MaxHeaderBytes = %d", server.MaxHeaderBytes)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout must remain disabled for SSE, got %s", server.WriteTimeout)
	}
}
