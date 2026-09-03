package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

// Highest-rank-wins derivation with the defaultRole fallback: an org with
// no mappings (or only unknown role names) behaves byte-for-byte like the
// pre-v2 flat defaultRole.
func TestDeriveScimRole(t *testing.T) {
	mappings := map[string]string{"g-admin": "admin", "g-edit": "editor", "g-view": "viewer"}
	cases := []struct {
		groups []string
		want   string
	}{
		{[]string{"g-view", "g-admin", "g-edit"}, "admin"},
		{[]string{"g-view", "g-edit"}, "editor"},
		{[]string{"g-view"}, "viewer"},
		{[]string{"g-unmapped"}, "viewer"}, // no mapped group → defaultRole
		{nil, "viewer"},
	}
	for _, c := range cases {
		if got := deriveScimRole(c.groups, mappings, "viewer"); got != c.want {
			t.Fatalf("groups %v: got %q want %q", c.groups, got, c.want)
		}
	}
	// Unknown / custom role names rank -1 and never beat a built-in; a
	// map with ONLY unknowns falls through to defaultRole.
	mixed := map[string]string{"g-custom": "billing-admin", "g-edit": "editor"}
	if got := deriveScimRole([]string{"g-custom", "g-edit"}, mixed, "viewer"); got != "editor" {
		t.Fatalf("unknown role must never win: %q", got)
	}
	if got := deriveScimRole([]string{"g-custom"}, mixed, "editor"); got != "editor" {
		t.Fatalf("only-unknown mappings must fall back: %q", got)
	}
}

func signScimHeader(secret, body string, atMs int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.%s", atMs, body)
	return fmt.Sprintf("t=%d,v1=%s", atMs, hex.EncodeToString(mac.Sum(nil)))
}

// The verifier fails CLOSED (no secret rejects everything) and walks the
// contract's exact reason ladder.
func TestVerifyWorkOsSignature(t *testing.T) {
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	body := `{"id":"evt_1"}`
	secret := "whsec_test"
	valid := signScimHeader(secret, body, now.UnixMilli())

	cases := []struct {
		name   string
		header string
		secret string
		reason string
	}{
		{"missing secret fails closed", valid, "", "missing_secret"},
		{"missing header", "", secret, "missing_header"},
		{"malformed header", "t=abc", secret, "malformed_header"},
		{"non-hex signature", fmt.Sprintf("t=%d,v1=zz", now.UnixMilli()), secret, "malformed_header"},
		{"expired", signScimHeader(secret, body, now.Add(-6*time.Minute).UnixMilli()), secret, "expired"},
		{"future timestamp", signScimHeader(secret, body, now.Add(6*time.Minute).UnixMilli()), secret, "future_timestamp"},
		{"wrong secret", signScimHeader("other", body, now.UnixMilli()), secret, "signature_mismatch"},
	}
	for _, c := range cases {
		ok, reason := verifyWorkOsSignature(c.header, body, c.secret, now)
		if ok || reason != c.reason {
			t.Fatalf("%s: got (%v, %q) want reason %q", c.name, ok, reason, c.reason)
		}
	}
	if ok, reason := verifyWorkOsSignature(valid, body+" ", secret, now); ok || reason != "signature_mismatch" {
		t.Fatalf("tampered body: got (%v, %q)", ok, reason)
	}
	if ok, reason := verifyWorkOsSignature(valid, body, secret, now); !ok {
		t.Fatalf("valid signature rejected: %q", reason)
	}
}

// Email extraction mirrors the contract: direct field, primary-flagged
// array entry, first-entry fallback, custom_attributes nesting.
func TestScimPrimaryEmail(t *testing.T) {
	if got := scimPrimaryEmail(map[string]any{"email": "a@x.com"}); got != "a@x.com" {
		t.Fatalf("direct: %q", got)
	}
	withPrimary := map[string]any{"emails": []any{
		map[string]any{"value": "first@x.com"},
		map[string]any{"primary": true, "value": "primary@x.com"},
	}}
	if got := scimPrimaryEmail(withPrimary); got != "primary@x.com" {
		t.Fatalf("primary flag: %q", got)
	}
	noPrimary := map[string]any{"emails": []any{map[string]any{"value": "only@x.com"}}}
	if got := scimPrimaryEmail(noPrimary); got != "only@x.com" {
		t.Fatalf("first fallback: %q", got)
	}
	nested := map[string]any{"custom_attributes": map[string]any{"emails": []any{
		map[string]any{"primary": true, "value": "nested@x.com"},
	}}}
	if got := scimPrimaryEmail(nested); got != "nested@x.com" {
		t.Fatalf("custom_attributes: %q", got)
	}
	if got := scimPrimaryEmail(map[string]any{}); got != "" {
		t.Fatalf("missing email must be empty: %q", got)
	}
}
