// Package browsersession owns the opaque browser token, cookie attributes,
// and CSRF marker boundary used by cookie-authenticated routes.
package browsersession

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/internal/signedtoken"
)

const (
	Purpose    = "sso_session"
	CookieName = "janusly_session"
	CSRFHeader = "x-janusly-csrf"
)

// ErrInvalidCSRF is intentionally uniform across missing marker and origin.
var ErrInvalidCSRF = errors.New("Forbidden: invalid browser session origin") //nolint:staticcheck // contract message is the wire contract

type tokenPayload struct {
	SessionID string `json:"sessionId"`
}

// Token is the signed opaque value plus its exact signed expiry.
type Token struct {
	Value     string
	ExpiresAt time.Time
}

// CreateToken signs only the server-side session row id.
func CreateToken(sessionID string, ttlSeconds int) (Token, error) {
	if sessionID == "" {
		return Token{}, signedtoken.ErrInvalid
	}
	value, envelope, err := signedtoken.Sign(Purpose, tokenPayload{SessionID: sessionID}, ttlSeconds)
	if err != nil {
		return Token{}, err
	}
	return Token{Value: value, ExpiresAt: time.Unix(envelope.ExpiresAt, 0)}, nil
}

// ReadSessionID authenticates and extracts the opaque id from request cookies.
func ReadSessionID(r *http.Request) string {
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return ""
	}
	envelope, err := signedtoken.Verify[tokenPayload](cookie.Value, Purpose)
	if err != nil || envelope.Payload.SessionID == "" {
		return ""
	}
	return envelope.Payload.SessionID
}

// SessionCookie serializes the successful-login or organization-switch cookie.
func SessionCookie(token string, ttlSeconds int) string {
	return cookieValue(token, max(ttlSeconds, 0))
}

// ClearCookie expires the browser cookie immediately.
func ClearCookie() string {
	return cookieValue("", 0)
}

func cookieValue(token string, ttlSeconds int) string {
	value := CookieName + "=" + url.QueryEscape(token) +
		"; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + strconv.Itoa(ttlSeconds)
	if secureCookie() {
		value += "; Secure"
	}
	return value
}

// SecureCookie exposes the deployment's cookie posture so sibling flows
// (the SSO state binding) inherit it instead of re-deriving it.
func SecureCookie() bool { return secureCookie() }

func secureCookie() bool {
	switch os.Getenv("JANUSLY_SESSION_COOKIE_SECURE") {
	case "true":
		return true
	case "false":
		return false
	}
	base, err := url.Parse(os.Getenv("JANUSLY_WEB_BASE_URL"))
	return err == nil && base.Scheme == "https"
}

// RequireCSRF requires both Janusly's custom marker and a concrete allowed
// origin. The caller supplies the same origin policy used by CORS.
func RequireCSRF(r *http.Request, originAllowed func(string) bool) error {
	if originAllowed == nil || r.Header.Get(CSRFHeader) != "1" ||
		!originAllowed(r.Header.Get("Origin")) {
		return ErrInvalidCSRF
	}
	return nil
}
