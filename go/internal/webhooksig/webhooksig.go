// Shared inbound-webhook signature core (T-528): the 80% every verifier
// repeats — `k=v` header parsing, hex sanity, HMAC-SHA256 over a
// composed payload, constant-time compare, bounded clock skew,
// multi-candidate tolerance — with the per-provider POSTURES (header
// format, window, payload composition, reason vocabulary) as
// configuration. WorkOS/SCIM, external-runtime, PagerDuty, and Slack
// ride this module; their existing signature matrices are the guard.
package webhooksig

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

// ParseHeader splits a `t=...,v1=...` style header into the timestamp
// raw value and every candidate signature under sigKey (providers may
// send multiple candidates during secret rotation).
func ParseHeader(header, timestampKey, sigKey string) (timestampRaw string, candidates []string) {
	for part := range strings.SplitSeq(header, ",") {
		key, value, found := strings.Cut(strings.TrimSpace(part), "=")
		if !found {
			continue
		}
		switch key {
		case timestampKey:
			timestampRaw = value
		case sigKey:
			candidates = append(candidates, strings.ToLower(value))
		}
	}
	return timestampRaw, candidates
}

// Posture is one provider's verification contract.
type Posture struct {
	// Compose builds the exact signed payload from the raw timestamp
	// value and the raw body.
	Compose func(timestampRaw, body string) string
	// ToleranceSeconds bounds |now - timestamp|; 0 disables the check
	// (providers without a timestamp, e.g. PagerDuty V3).
	ToleranceSeconds int64
	// TimestampMillis marks providers whose t= is unix milliseconds.
	TimestampMillis bool
	// AsymmetricSkewReasons distinguishes expired vs future_timestamp
	// (WorkOS posture); false collapses both to timestamp_skew.
	AsymmetricSkewReasons bool
}

// Verify runs the shared ladder. reason "" means the signature is valid;
// canonical reasons: missing_secret, malformed_header, expired,
// future_timestamp, timestamp_skew, signature_mismatch.
func Verify(timestampRaw string, candidates []string, body, secret string, nowUnixSeconds int64, posture Posture) (timestampSeconds int64, reason string) {
	if secret == "" {
		return 0, "missing_secret"
	}
	if posture.ToleranceSeconds > 0 {
		value, err := strconv.ParseInt(timestampRaw, 10, 64)
		if err != nil || value <= 0 {
			return 0, "malformed_header"
		}
		timestampSeconds = value
		if posture.TimestampMillis {
			timestampSeconds = value / 1000
		}
		skew := nowUnixSeconds - timestampSeconds
		switch {
		case skew > posture.ToleranceSeconds:
			if posture.AsymmetricSkewReasons {
				return 0, "expired"
			}
			return 0, "timestamp_skew"
		case skew < -posture.ToleranceSeconds:
			if posture.AsymmetricSkewReasons {
				return 0, "future_timestamp"
			}
			return 0, "timestamp_skew"
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(posture.Compose(timestampRaw, body)))
	expected := mac.Sum(nil)
	sawCandidate := false
	for _, candidate := range candidates {
		if len(candidate)%2 != 0 {
			continue
		}
		decoded, err := hex.DecodeString(candidate)
		if err != nil || len(decoded) != len(expected) {
			continue
		}
		sawCandidate = true
		if hmac.Equal(decoded, expected) {
			return timestampSeconds, ""
		}
	}
	if !sawCandidate {
		return 0, "malformed_header"
	}
	return 0, "signature_mismatch"
}
