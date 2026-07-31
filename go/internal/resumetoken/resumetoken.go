// Signed resume tokens for surfaces that carry user-submitted data,
// ported from the reference's secrets.ts: HMAC-SHA256 over
// `v1.<base64url(payload)>`, payload bound to (orgId, runId, nodeId,
// purpose) with a SIGNED issuedAt + expiresAt so later policy changes
// cannot rewrite an already-issued token's lifetime. The secret is the
// dedicated JANUSLY_RESUME_TOKEN_SECRET — never the API service token
// (different rotation schedules, different log surfaces; sharing would
// let bearer-token leakage forge form links). Dev falls back to a fixed
// local secret; production mode refuses to run without the real one.
// Verification errors are deliberately uniform ("Invalid resume token")
// so callers map every failure to one 403 without leaking WHICH
// constraint failed.
package resumetoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	tokenVersion   = "v1"
	devSecret      = "janusly-dev-resume-token-secret"
	secretEnv      = "JANUSLY_RESUME_TOKEN_SECRET"
	productionMode = "JANUSLY_PRODUCTION_MODE"

	// MinTTLSeconds..DefaultTTLSeconds is the closed range for newly
	// issued tokens ("left over a long weekend" without an indefinite
	// shelf life for a leaked URL).
	MinTTLSeconds     = 5 * 60
	DefaultTTLSeconds = 7 * 24 * 60 * 60
)

// ErrInvalid is the uniform verification failure.
var ErrInvalid = errors.New("Invalid resume token") //nolint:staticcheck // reference message is the wire contract

// Payload is the signed binding.
type Payload struct {
	OrgID   string `json:"orgId"`
	RunID   string `json:"runId"`
	NodeID  string `json:"nodeId"`
	Purpose string `json:"purpose"`
	// IssuedAt is Unix seconds. Legacy tokens without expiresAt use the
	// seven-day verifier fallback.
	IssuedAt int64 `json:"issuedAt"`
	// ExpiresAt is Unix seconds, signed at issuance; zero means absent
	// (legacy v1).
	ExpiresAt int64 `json:"expiresAt,omitempty"`
}

// Binding is the expected identity a token must match.
type Binding struct {
	OrgID   string
	RunID   string
	NodeID  string
	Purpose string
}

func secret() (string, error) {
	if configured := os.Getenv(secretEnv); configured != "" {
		return configured, nil
	}
	if os.Getenv(productionMode) == "true" {
		return "", fmt.Errorf("%s is required in production", secretEnv)
	}
	return devSecret, nil
}

func signPayload(encodedPayload string) (string, error) {
	key, err := secret()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(tokenVersion + "." + encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// Sign creates a token for the binding with the given TTL (clamped
// validation: outside [MinTTLSeconds, DefaultTTLSeconds] is an error, the
// caller resolves policy BEFORE signing).
func Sign(binding Binding, ttlSeconds int) (string, error) {
	if ttlSeconds < MinTTLSeconds || ttlSeconds > DefaultTTLSeconds {
		return "", errors.New("Invalid resume token TTL") //nolint:staticcheck // reference message
	}
	issuedAt := time.Now().Unix()
	payload := Payload{
		OrgID: binding.OrgID, RunID: binding.RunID, NodeID: binding.NodeID,
		Purpose: binding.Purpose, IssuedAt: issuedAt, ExpiresAt: issuedAt + int64(ttlSeconds),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	signature, err := signPayload(encoded)
	if err != nil {
		return "", err
	}
	return tokenVersion + "." + encoded + "." + signature, nil
}

// Verify checks signature, binding, and the signed expiry. Legacy tokens
// without expiresAt keep the original verifier boundary: valid AT exactly
// seven days, expired one second later.
func Verify(token string, expected Binding) (*Payload, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != tokenVersion {
		return nil, ErrInvalid
	}
	expectedSignature, err := signPayload(parts[1])
	if err != nil {
		return nil, err
	}
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSignature)) {
		return nil, ErrInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalid
	}
	var payload Payload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return nil, ErrInvalid
	}
	if payload.OrgID != expected.OrgID || payload.RunID != expected.RunID ||
		payload.NodeID != expected.NodeID || payload.Purpose != expected.Purpose ||
		payload.IssuedAt == 0 {
		return nil, ErrInvalid
	}
	now := time.Now().Unix()
	if payload.ExpiresAt == 0 {
		if now-payload.IssuedAt > DefaultTTLSeconds {
			return nil, ErrInvalid
		}
	} else if payload.ExpiresAt <= payload.IssuedAt ||
		payload.ExpiresAt-payload.IssuedAt > DefaultTTLSeconds ||
		payload.ExpiresAt <= now {
		return nil, ErrInvalid
	}
	return &payload, nil
}

// SignLegacy issues a v1 token WITHOUT expiresAt (test support for the
// legacy-verifier boundary; production issuance always signs an expiry).
func SignLegacy(binding Binding, issuedAt int64) (string, error) {
	payload := Payload{
		OrgID: binding.OrgID, RunID: binding.RunID, NodeID: binding.NodeID,
		Purpose: binding.Purpose, IssuedAt: issuedAt,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	signature, err := signPayload(encoded)
	if err != nil {
		return "", err
	}
	return tokenVersion + "." + encoded + "." + signature, nil
}
