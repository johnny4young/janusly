// Package signedtoken provides purpose-separated, expiring HMAC tokens for
// opaque browser sessions and one-time authentication state.
package signedtoken

import (
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/johnny4young/janusly/internal/tokenhmac"
)

// ErrInvalid is the uniform verification failure.
var ErrInvalid = errors.New("Invalid signed token") //nolint:staticcheck // contract message is the wire contract

// Envelope is the authenticated token body. Payload remains typed at the
// caller while purpose and lifetime are always verified here.
type Envelope[T any] struct {
	Purpose   string `json:"purpose"`
	Payload   T      `json:"payload"`
	IssuedAt  int64  `json:"issuedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// Sign creates a purpose-bound token. A positive TTL is required.
func Sign[T any](purpose string, payload T, ttlSeconds int) (string, Envelope[T], error) {
	return signAt(purpose, payload, ttlSeconds, time.Now())
}

func signAt[T any](purpose string, payload T, ttlSeconds int, now time.Time) (string, Envelope[T], error) {
	var zero Envelope[T]
	issuedAt := now.Unix()
	if purpose == "" || ttlSeconds <= 0 || int64(ttlSeconds) > math.MaxInt64-issuedAt {
		return "", zero, ErrInvalid
	}
	envelope := Envelope[T]{
		Purpose: purpose, Payload: payload, IssuedAt: issuedAt,
		ExpiresAt: issuedAt + int64(ttlSeconds),
	}
	token, err := tokenhmac.SignJSON(envelope)
	if err != nil {
		return "", zero, err
	}
	return token, envelope, nil
}

// Verify checks signature, exact purpose, shape, and signed expiry.
func Verify[T any](token, expectedPurpose string) (*Envelope[T], error) {
	return verifyAt[T](token, expectedPurpose, time.Now())
}

func verifyAt[T any](token, expectedPurpose string, now time.Time) (*Envelope[T], error) {
	var raw struct {
		Purpose   string          `json:"purpose"`
		Payload   json.RawMessage `json:"payload"`
		IssuedAt  int64           `json:"issuedAt"`
		ExpiresAt int64           `json:"expiresAt"`
	}
	if err := tokenhmac.VerifyJSON(token, &raw); err != nil {
		if errors.Is(err, tokenhmac.ErrInvalid) {
			return nil, ErrInvalid
		}
		return nil, err
	}
	if expectedPurpose == "" || raw.Purpose != expectedPurpose || raw.IssuedAt <= 0 ||
		raw.ExpiresAt <= raw.IssuedAt || raw.ExpiresAt <= now.Unix() || len(raw.Payload) == 0 {
		return nil, ErrInvalid
	}
	var payload T
	if err := json.Unmarshal(raw.Payload, &payload); err != nil {
		return nil, ErrInvalid
	}
	return &Envelope[T]{
		Purpose: raw.Purpose, Payload: payload,
		IssuedAt: raw.IssuedAt, ExpiresAt: raw.ExpiresAt,
	}, nil
}
