package agentclient

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestTokenShapeAndDigest(t *testing.T) {
	token, digest, last4, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, TokenPrefix) || !wellFormed(token) || len(digest) != 32 || !strings.HasSuffix(token, last4) {
		t.Fatalf("token %q digest %d last4 %q", token, len(digest), last4)
	}
	if string(Digest(token)) != string(digest) {
		t.Fatal("digest is not stable")
	}
	other, _, _, _ := NewToken()
	if other == token {
		t.Fatal("tokens repeat")
	}
	for _, bad := range []string{"", TokenPrefix, token + "x", strings.Replace(token, TokenPrefix, "jly_agnt_", 1), token[:len(token)-1] + "!"} {
		if wellFormed(bad) {
			t.Fatalf("accepted malformed token %q", bad)
		}
	}
}

func TestCapabilitiesImplyReadAndMapToPermissions(t *testing.T) {
	capabilities, err := ParseCapabilities([]string{"operate", "operate"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(Strings(capabilities), []string{"read", "operate"}) {
		t.Fatalf("capabilities = %v", capabilities)
	}
	permissions := CeilingPermissions(capabilities)
	for _, want := range []string{"workflows.read", "runs.start", "dlq.replay", "workflows.write"} {
		if !permissions[want] {
			t.Fatalf("operate ceiling lacks %s", want)
		}
	}
	if permissions["ai.write"] || permissions["members.write"] || permissions["credentials.write"] {
		t.Fatalf("ceiling grants more than its tools need: %v", permissions)
	}
	if _, err := ParseCapabilities([]string{"admin"}); !errors.Is(err, ErrUnknownCapability) {
		t.Fatalf("unknown capability accepted: %v", err)
	}
	if missing := MissingPermissions(capabilities, map[string]bool{"workflows.read": true}); !slices.Contains(missing, "runs.start") {
		t.Fatalf("missing = %v", missing)
	}
}

func TestIssueRejectsBeforeTouchingTheStore(t *testing.T) {
	held := CeilingPermissions([]Capability{CapabilityRead})
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		in   IssueInput
		code string
	}{
		{"blank name", IssueInput{Name: " "}, "invalid_name"},
		{"unknown capability", IssueInput{Name: "a", Capabilities: []string{"root"}}, "invalid_capabilities"},
		{"beyond the creator's grant", IssueInput{Name: "a", Capabilities: []string{"operate"}}, "capability_exceeds_grant"},
		{"blank scope tag", IssueInput{Name: "a", ScopeTags: []string{" "}}, "invalid_scope"},
		{"oversized tag", IssueInput{Name: "a", ScopeTags: []string{strings.Repeat("t", 61)}}, "invalid_scope"},
		{"control character", IssueInput{Name: "a", ScopeWorkflowIDs: []string{"wf\n1"}}, "invalid_scope"},
		{"expiry past 90 days", IssueInput{Name: "a", ExpiresInDays: 91}, "invalid_expiry"},
		{"rate above the cap", IssueInput{Name: "a", RateLimitPerMinute: 601}, "invalid_rate_limit"},
	}
	for _, tc := range cases {
		_, err := Issue(context.Background(), nil, "id", now, tc.in, held)
		var input *InputError
		if !errors.As(err, &input) || input.Code != tc.code {
			t.Fatalf("%s: err = %v, want %s", tc.name, err, tc.code)
		}
	}
}

func TestPrincipalIdentityAndScope(t *testing.T) {
	principal := &Principal{ClientID: "c1"}
	if principal.ActorID() != "agent:c1" || principal.Scoped() {
		t.Fatalf("unscoped principal: %q %v", principal.ActorID(), principal.Scoped())
	}
	principal.ScopeTags = []string{"billing"}
	if !principal.Scoped() {
		t.Fatal("tag scope not detected")
	}
}
