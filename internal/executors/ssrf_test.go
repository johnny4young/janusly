package executors

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"testing"
)

// SSRF matrix ported from the http-policy.ts posture: every blocked class,
// hostname aliases, resolved-private rejection, and the pinning guarantee.

func denyAll() func() bool { return func() bool { return false } }

func staticResolver(ips ...string) ResolveFunc {
	return func(context.Context, string) ([]net.IP, error) {
		out := make([]net.IP, 0, len(ips))
		for _, ip := range ips {
			out = append(out, net.ParseIP(ip))
		}
		return out, nil
	}
}

func validateTarget(t *testing.T, rawURL string, resolve ResolveFunc) error {
	t.Helper()
	e := &httpExecutor{opts: HTTPOptions{Resolve: resolve, AllowPrivate: denyAll()}}
	_, err := e.validate(context.Background(), rawURL, &pinnedDialer{byHost: map[string]net.IP{}})
	return err
}

func TestSSRFMatrixRejectsEveryBlockedClass(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want string
	}{
		{"loopback ip", "http://127.0.0.1/admin", "private and blocked"},
		{"loopback range", "http://127.8.9.10/", "private and blocked"},
		{"localhost alias", "http://localhost:8080/", "private and blocked"},
		{"localhost subdomain", "http://app.localhost/", "private and blocked"},
		{"rfc1918 ten", "http://10.0.0.5/", "private and blocked"},
		{"rfc1918 oneseventwo", "http://172.31.255.1/", "private and blocked"},
		{"rfc1918 oneninetwo", "http://192.168.1.1/", "private and blocked"},
		{"aws metadata", "http://169.254.169.254/latest/meta-data/", "private and blocked"},
		{"link local", "http://169.254.10.10/", "private and blocked"},
		{"cgnat", "http://100.64.0.1/", "private and blocked"},
		{"zero network", "http://0.0.0.0/", "private and blocked"},
		{"multicast", "http://224.0.0.1/", "private and blocked"},
		{"ipv6 loopback", "http://[::1]/", "private and blocked"},
		{"ipv6 link local", "http://[fe80::1]/", "private and blocked"},
		{"ipv6 ula", "http://[fd12:3456::1]/", "private and blocked"},
		{"ipv6 mapped ipv4", "http://[::ffff:127.0.0.1]/", "private and blocked"},
		{"file scheme", "file:///etc/passwd", "Unsupported HTTP target protocol"},
		{"gopher scheme", "gopher://example.com/", "Unsupported HTTP target protocol"},
		{"empty url", "   ", "HTTP target url is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTarget(t, tc.url, staticResolver("93.184.216.34"))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("%s: expected %q, got %v", tc.url, tc.want, err)
			}
		})
	}
}

func TestHostnameResolvingToPrivateIsBlocked(t *testing.T) {
	// The classic bypass: a public-looking hostname whose DNS answer is
	// private (e.g. an attacker's A record pointing at the metadata IP).
	for _, private := range []string{"169.254.169.254", "10.0.0.8", "127.0.0.1", "::1"} {
		err := validateTarget(t, "http://api.attacker.example/", staticResolver(private))
		if err == nil || !strings.Contains(err.Error(), "resolves to a private address and is blocked") {
			t.Fatalf("resolved %s must be blocked, got %v", private, err)
		}
	}
	// Mixed answers: ONE private address poisons the whole set.
	err := validateTarget(t, "http://api.attacker.example/",
		staticResolver("93.184.216.34", "169.254.169.254"))
	if err == nil || !strings.Contains(err.Error(), "resolves to a private address") {
		t.Fatalf("mixed answer must be blocked, got %v", err)
	}
}

func TestPublicTargetValidatesAndPins(t *testing.T) {
	e := &httpExecutor{opts: HTTPOptions{
		Resolve: staticResolver("93.184.216.34"), AllowPrivate: denyAll(),
	}}
	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	target, err := e.validate(context.Background(), "https://api.example.com/v1", pins)
	if err != nil || target.Host != "api.example.com" {
		t.Fatalf("public target must validate: %v %v", target, err)
	}
	if pinned := pins.byHost["api.example.com"]; pinned == nil || pinned.String() != "93.184.216.34" {
		t.Fatalf("first validated address must be pinned, got %v", pinned)
	}
}

func TestDialRefusesUnvalidatedAndPrivatePins(t *testing.T) {
	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	if _, err := pins.dial(context.Background(), "tcp", "sneaky.example:80"); err == nil ||
		!strings.Contains(err.Error(), "refusing to dial unvalidated host") {
		t.Fatalf("unvalidated host must not dial: %v", err)
	}
	pins.pin("evil.example", net.ParseIP("169.254.169.254"))
	if _, err := pins.dial(context.Background(), "tcp", "evil.example:80"); err == nil ||
		!strings.Contains(err.Error(), "Pinned HTTP target IP is private and blocked") {
		t.Fatalf("private pin must refuse at the socket: %v", err)
	}
}

func TestRebindingResolverCannotRedirectTheDial(t *testing.T) {
	// Rebinding by construction: the resolver is consulted exactly once —
	// validation — and the dial goes to that pinned answer. A second answer
	// (the attack) never reaches the socket because nothing re-resolves.
	var calls atomic.Int32
	rebinding := func(context.Context, string) ([]net.IP, error) {
		if calls.Add(1) == 1 {
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		}
		return []net.IP{net.ParseIP("169.254.169.254")}, nil
	}
	e := &httpExecutor{opts: HTTPOptions{Resolve: rebinding, AllowPrivate: denyAll()}}
	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	if _, err := e.validate(context.Background(), "http://rebind.example/", pins); err != nil {
		t.Fatalf("first (public) answer must validate: %v", err)
	}
	if got := pins.byHost["rebind.example"].String(); got != "93.184.216.34" {
		t.Fatalf("pin must hold the validated answer, got %s", got)
	}
	if calls.Load() != 1 {
		t.Fatalf("resolver consulted %d times; pinning requires exactly one", calls.Load())
	}
	// Even if an attacker somehow flipped the pin map to the private answer,
	// the dial-side guard refuses (defense in depth, proven above).
	_ = fmt.Sprintf("%v", pins)
}
