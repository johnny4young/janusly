// Package ssostate owns the purpose-bound, one-time WorkOS callback state.
// The signed token proves the organization, nonce, callback binding, and
// lifetime; the database nonce claim independently prevents replay.
package ssostate

import (
	"errors"
	"time"

	"github.com/johnny4young/janusly/go/internal/signedtoken"
)

const (
	Purpose    = "sso_state"
	TTLSeconds = 10 * 60
)

// Payload order is the Node wire order and therefore part of the HMAC bytes.
type Payload struct {
	OrgID       string `json:"orgId"`
	Nonce       string `json:"nonce"`
	CallbackURL string `json:"callbackUrl"`
}

// Token carries the signed value and database expiry derived from the same
// authenticated envelope, avoiding two independently computed clocks.
type Token struct {
	Value     string
	ExpiresAt time.Time
}

// Create signs one ten-minute state token.
func Create(orgID, nonce, callbackURL string) (Token, error) {
	if orgID == "" || nonce == "" || callbackURL == "" {
		return Token{}, signedtoken.ErrInvalid
	}
	value, envelope, err := signedtoken.Sign(Purpose, Payload{
		OrgID: orgID, Nonce: nonce, CallbackURL: callbackURL,
	}, TTLSeconds)
	if err != nil {
		return Token{}, err
	}
	return Token{Value: value, ExpiresAt: time.Unix(envelope.ExpiresAt, 0)}, nil
}

// Verify checks the HMAC, purpose, expiry, and required binding fields.
func Verify(value string) (*signedtoken.Envelope[Payload], error) {
	envelope, err := signedtoken.Verify[Payload](value, Purpose)
	if err != nil {
		return nil, err
	}
	if envelope.Payload.OrgID == "" || envelope.Payload.Nonce == "" || envelope.Payload.CallbackURL == "" {
		return nil, signedtoken.ErrInvalid
	}
	return envelope, nil
}

// IsInvalid keeps route error mapping independent from token internals.
func IsInvalid(err error) bool { return errors.Is(err, signedtoken.ErrInvalid) }
