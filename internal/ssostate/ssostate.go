// Package ssostate owns the purpose-bound, one-time WorkOS callback state.
// The signed token proves the organization, nonce, callback binding, and
// lifetime; the database nonce claim independently prevents replay.
package ssostate

import (
	"crypto/subtle"
	"errors"
	"net/url"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/internal/signedtoken"
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

// BrowserCookieName carries the flow's nonce back from the browser that
// STARTED the login. The signed state proves "Janusly issued this"; the
// database nonce proves "used once". Neither proves "used by the same
// browser that asked for it" — without that third leg an attacker can
// capture their OWN authorize redirect and hand the resulting callback
// URL to a victim, whose browser then completes a login into the
// ATTACKER's identity (OAuth login-CSRF).
const BrowserCookieName = "janusly_sso_state"

// BrowserCookie serializes the binding cookie. SameSite=Lax is required,
// not incidental: the identity provider returns through a top-level GET
// navigation, which Strict would refuse to send the cookie on.
func BrowserCookie(nonce string, secure bool) string {
	value := BrowserCookieName + "=" + url.QueryEscape(nonce) +
		"; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + strconv.Itoa(TTLSeconds)
	if secure {
		value += "; Secure"
	}
	return value
}

// ClearBrowserCookie expires the binding immediately: one flow, one cookie.
func ClearBrowserCookie(secure bool) string {
	value := BrowserCookieName + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
	if secure {
		value += "; Secure"
	}
	return value
}

// BrowserBindingMatches compares in constant time.
func BrowserBindingMatches(cookieNonce, stateNonce string) bool {
	if cookieNonce == "" || stateNonce == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(cookieNonce), []byte(stateNonce)) == 1
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
