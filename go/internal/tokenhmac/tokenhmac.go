// Package tokenhmac owns the versioned HMAC envelope shared by signed
// browser, SSO-state, and human-resume tokens. Callers retain their own
// purpose-specific payload and expiry validation.
package tokenhmac

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

const (
	version   = "v1"
	secretEnv = "JANUSLY_RESUME_TOKEN_SECRET"
	devSecret = "janusly-dev-resume-token-secret"
)

// ErrInvalid is deliberately context-free so callers do not disclose which
// part of a signed token failed verification.
var ErrInvalid = errors.New("invalid signed token envelope")

// SignJSON serializes payload and signs the exact v1.base64url bytes.
func SignJSON(payload any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	signature, err := signPayload(encoded)
	if err != nil {
		return "", err
	}
	return version + "." + encoded + "." + signature, nil
}

// VerifyJSON authenticates token before decoding its JSON payload into out.
func VerifyJSON(token string, out any) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != version {
		return ErrInvalid
	}
	expectedSignature, err := signPayload(parts[1])
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSignature)) {
		return ErrInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ErrInvalid
	}
	if err := json.Unmarshal(decoded, out); err != nil {
		return ErrInvalid
	}
	return nil
}

func signPayload(encodedPayload string) (string, error) {
	key, err := secret()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(version + "." + encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func secret() (string, error) {
	if configured := os.Getenv(secretEnv); configured != "" {
		return configured, nil
	}
	if os.Getenv("JANUSLY_GO_ENV") == "production" ||
		os.Getenv("JANUSLY_PRODUCTION_MODE") == "true" ||
		os.Getenv("NODE_ENV") == "production" {
		return "", fmt.Errorf("%s is required in production", secretEnv)
	}
	return devSecret, nil
}
