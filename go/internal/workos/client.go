// Package workos is the minimal guarded WorkOS SSO client. Authorization URL
// construction is pure; code exchange uses the shared SSRF-validated,
// DNS-pinned HTTP chokepoint and never stores or returns the access token.
package workos

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/johnny4young/janusly/go/internal/executors"
)

const (
	defaultAuthorizeURL = "https://api.workos.com/sso/authorize"
	defaultTokenURL     = "https://api.workos.com/sso/token"
	apiVersion          = "2024-07-01"
	exchangeTimeoutMs   = 30_000
	exchangeBodyCap     = 64 * 1024
)

var (
	ErrClientIDNotConfigured = errors.New("WORKOS_CLIENT_ID is not set")
	ErrAPIKeyNotConfigured   = errors.New("WORKOS_API_KEY is not set")
)

// FetchFunc is the guarded egress seam. Production uses
// executors.FetchHTTPTarget; tests substitute an in-memory response.
type FetchFunc func(context.Context, string, executors.FetchOptions) (executors.FetchResult, error)

// Config contains deployment credentials and test-only dependency seams.
// Empty endpoints resolve to the fixed WorkOS hosts.
type Config struct {
	ClientID, APIKey       string
	AuthorizeURL, TokenURL string
	Fetch                  FetchFunc
}

// Client owns the two WorkOS operations used by the SSO routes.
type Client struct {
	clientID, apiKey       string
	authorizeURL, tokenURL string
	fetch                  FetchFunc
}

// New builds one client without performing network I/O.
func New(config Config) *Client {
	authorizeURL := config.AuthorizeURL
	if authorizeURL == "" {
		authorizeURL = defaultAuthorizeURL
	}
	tokenURL := config.TokenURL
	if tokenURL == "" {
		tokenURL = defaultTokenURL
	}
	fetch := config.Fetch
	if fetch == nil {
		fetch = executors.FetchHTTPTarget
	}
	return &Client{
		clientID: config.ClientID, apiKey: config.APIKey,
		authorizeURL: authorizeURL, tokenURL: tokenURL, fetch: fetch,
	}
}

// NewFromEnv reads deployment-owned WorkOS credentials. Missing credentials
// are reported only by the operation that needs them, matching the Node
// runtime: authorization start needs the client id; callback exchange also
// needs the secret key.
func NewFromEnv() *Client {
	return New(Config{ClientID: os.Getenv("WORKOS_CLIENT_ID"), APIKey: os.Getenv("WORKOS_API_KEY")})
}

// BuildAuthorizeURL scopes the browser authorization request to the exact
// WorkOS connection configured for the tenant.
func (c *Client) BuildAuthorizeURL(connectionID, redirectURI, state string) (string, error) {
	if c.clientID == "" {
		return "", ErrClientIDNotConfigured
	}
	parsed, err := url.Parse(c.authorizeURL)
	if err != nil {
		return "", fmt.Errorf("parse WorkOS authorization URL: %w", err)
	}
	query := parsed.Query()
	query.Set("client_id", c.clientID)
	query.Set("connection", connectionID)
	query.Set("redirect_uri", redirectURI)
	query.Set("response_type", "code")
	query.Set("state", state)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// Profile is the bounded identity projection returned by WorkOS.
type Profile struct {
	ID             string
	Email          string
	FirstName      *string
	LastName       *string
	ConnectionID   string
	OrganizationID *string
}

// ExchangeError keeps upstream status available for audit classification
// without exposing the WorkOS body or deployment secret.
type ExchangeError struct {
	StatusCode int
	message    string
}

func (e *ExchangeError) Error() string { return e.message }

// ExchangeCode exchanges a one-time authorization code through the shared
// guarded HTTP path. Redirects are disabled so a 307/308 cannot replay the
// form-encoded client secret to another origin.
func (c *Client) ExchangeCode(ctx context.Context, code, redirectURI string) (Profile, error) {
	if c.clientID == "" {
		return Profile{}, ErrClientIDNotConfigured
	}
	if c.apiKey == "" {
		return Profile{}, ErrAPIKeyNotConfigured
	}
	body := url.Values{
		"client_id":     {c.clientID},
		"client_secret": {c.apiKey},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
	}.Encode()
	result, err := c.fetch(ctx, c.tokenURL, executors.FetchOptions{
		Method: http.MethodPost,
		Headers: map[string]string{
			"Content-Type":   "application/x-www-form-urlencoded",
			"WorkOS-Version": apiVersion,
			"Accept":         "application/json",
		},
		Body: []byte(body), TimeoutMs: exchangeTimeoutMs,
		MaxResponseBytes: exchangeBodyCap, DisableRedirects: true,
	})
	if err != nil {
		return Profile{}, fmt.Errorf("WorkOS token exchange failed: %w", err)
	}
	if !result.Ok {
		return Profile{}, &ExchangeError{
			StatusCode: result.StatusCode,
			message:    fmt.Sprintf("WorkOS token exchange failed with status %d", result.StatusCode),
		}
	}
	profile, ok := readProfile([]byte(result.Body))
	if !ok {
		return Profile{}, &ExchangeError{
			StatusCode: result.StatusCode,
			message:    "WorkOS token exchange response missing profile fields",
		}
	}
	return profile, nil
}

func readProfile(raw []byte) (Profile, bool) {
	var response struct {
		Profile *struct {
			ID             string  `json:"id"`
			Email          string  `json:"email"`
			FirstName      *string `json:"first_name"`
			LastName       *string `json:"last_name"`
			ConnectionID   string  `json:"connection_id"`
			OrganizationID *string `json:"organization_id"`
		} `json:"profile"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Profile == nil ||
		response.Profile.ID == "" || response.Profile.Email == "" || response.Profile.ConnectionID == "" {
		return Profile{}, false
	}
	return Profile{
		ID: response.Profile.ID, Email: strings.ToLower(response.Profile.Email),
		FirstName: response.Profile.FirstName, LastName: response.Profile.LastName,
		ConnectionID: response.Profile.ConnectionID, OrganizationID: response.Profile.OrganizationID,
	}, true
}
