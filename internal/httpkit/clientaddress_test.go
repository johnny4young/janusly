package httpkit

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientAddressTrustsOnlyTheProxysOwnHop(t *testing.T) {
	cases := []struct {
		name, trusted, forwarded, want string
	}{
		{"socket peer without a trusted proxy", "", "198.51.100.7", "192.0.2.10"},
		{"single hop behind the proxy", "true", "198.51.100.7", "198.51.100.7"},
		{"a client-supplied hop is ignored", "true", "203.0.113.99, 198.51.100.7", "198.51.100.7"},
		{"rotating the spoofed hop keeps the bucket", "true", "203.0.113.1,198.51.100.7", "198.51.100.7"},
		{"IPv6 is normalized", "true", "2001:DB8:0:0::1", "2001:db8::1"},
		{"a malformed hop falls back to the peer", "true", "not-an-ip", "192.0.2.10"},
		{"an oversized hop falls back to the peer", "true", strings.Repeat("9", 4096), "192.0.2.10"},
		{"an empty header falls back to the peer", "true", "", "192.0.2.10"},
	}
	for _, tc := range cases {
		t.Setenv("JANUSLY_TRUSTED_PROXY", tc.trusted)
		r := httptest.NewRequest("POST", "/mcp", nil)
		r.RemoteAddr = "192.0.2.10:52100"
		if tc.forwarded != "" {
			r.Header.Set("X-Forwarded-For", tc.forwarded)
		}
		if got := ClientAddress(r); got != tc.want {
			t.Errorf("%s: ClientAddress = %q, want %q", tc.name, got, tc.want)
		}
	}
}
