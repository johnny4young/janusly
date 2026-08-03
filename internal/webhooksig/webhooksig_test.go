package webhooksig

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func sign(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// The shared ladder: parse, skew postures, multi-candidate rotation,
// canonical reason vocabulary.
func TestVerifyLadder(t *testing.T) {
	posture := Posture{
		Compose:          func(ts, body string) string { return ts + "." + body },
		ToleranceSeconds: 300,
	}
	now := int64(1_700_000_000)
	good := sign("shh", "1700000000.body")

	timestampRaw, candidates := ParseHeader("t=1700000000, v1="+good, "t", "v1")
	if ts, reason := Verify(timestampRaw, candidates, "body", "shh", now, posture); reason != "" || ts != now {
		t.Fatalf("valid: ts=%d reason=%q", ts, reason)
	}
	// Rotation: a stale candidate beside the good one still verifies.
	_, rotated := ParseHeader("t=1700000000,v1="+sign("old-secret", "1700000000.body")+",v1="+good, "t", "v1")
	if _, reason := Verify("1700000000", rotated, "body", "shh", now, posture); reason != "" {
		t.Fatalf("rotation must tolerate stale candidates: %q", reason)
	}
	if _, reason := Verify("", nil, "body", "", now, posture); reason != "missing_secret" {
		t.Fatalf("missing secret: %q", reason)
	}
	if _, reason := Verify("not-a-number", candidates, "body", "shh", now, posture); reason != "malformed_header" {
		t.Fatalf("bad timestamp: %q", reason)
	}
	if _, reason := Verify("1700000000", candidates, "body", "shh", now+9999, posture); reason != "timestamp_skew" {
		t.Fatalf("skew: %q", reason)
	}
	if _, reason := Verify("1700000000", []string{"zz-not-hex"}, "body", "shh", now, posture); reason != "malformed_header" {
		t.Fatalf("non-hex candidate: %q", reason)
	}
	if _, reason := Verify("1700000000", []string{sign("wrong", "1700000000.body")}, "body", "shh", now, posture); reason != "signature_mismatch" {
		t.Fatalf("mismatch: %q", reason)
	}

	// WorkOS posture: millisecond timestamps + asymmetric skew reasons.
	workos := Posture{
		Compose:          func(ts, body string) string { return ts + "." + body },
		ToleranceSeconds: 300, TimestampMillis: true, AsymmetricSkewReasons: true,
	}
	if _, reason := Verify("1699000000000", []string{sign("shh", "1699000000000.b")}, "b", "shh", now, workos); reason != "expired" {
		t.Fatalf("asymmetric expired: %q", reason)
	}
	if _, reason := Verify("1701000000000", []string{sign("shh", "1701000000000.b")}, "b", "shh", now, workos); reason != "future_timestamp" {
		t.Fatalf("asymmetric future: %q", reason)
	}

	// Timestampless posture (PagerDuty): body-only compose, no skew gate.
	pd := Posture{Compose: func(_, body string) string { return body }}
	if _, reason := Verify("", []string{sign("shh", "raw")}, "raw", "shh", 0, pd); reason != "" {
		t.Fatalf("timestampless: %q", reason)
	}
}
