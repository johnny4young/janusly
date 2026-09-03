// Package runbookclient provides the bounded HTTP client used by local
// operator tools. It intentionally exposes no Janusly domain operations: the
// admin and seed commands remain constrained to the same public API routes as
// every other caller.
package runbookclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// DefaultTimeout bounds a complete operator API call, including the body.
	DefaultTimeout = 10 * time.Second
	// MaxResponseBytes prevents a broken endpoint from exhausting CLI memory.
	MaxResponseBytes = int64(1 << 20)
	maxRedirects     = 5
)

// Config defines one organization-scoped API client.
type Config struct {
	BaseURL     string
	OrgID       string
	UserID      string
	BearerToken string
	Timeout     time.Duration
	HTTPClient  *http.Client
}

// Client sends bounded JSON calls to one fixed Janusly origin.
type Client struct {
	baseURL     *url.URL
	orgID       string
	userID      string
	bearerToken string
	timeout     time.Duration
	httpClient  *http.Client
}

// New validates the fixed API origin and constructs a redirect-safe client.
func New(cfg Config) (*Client, error) {
	baseURL, err := url.Parse(cfg.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse API base URL: %w", err)
	}
	if (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" {
		return nil, errors.New("API base URL must be an absolute http or https origin")
	}
	if baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" ||
		(baseURL.Path != "" && baseURL.Path != "/") {
		return nil, errors.New("API base URL must not contain credentials, a path, query, or fragment")
	}
	baseURL.Path = ""
	if cfg.Timeout < 0 {
		return nil, errors.New("API timeout must not be negative")
	}
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}

	httpClient := &http.Client{}
	if cfg.HTTPClient != nil {
		clone := *cfg.HTTPClient
		httpClient = &clone
	}
	previousRedirect := httpClient.CheckRedirect
	httpClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return errors.New("too many API redirects")
		}
		if !strings.EqualFold(req.URL.Scheme, baseURL.Scheme) ||
			!strings.EqualFold(req.URL.Host, baseURL.Host) {
			return errors.New("refusing cross-origin API redirect")
		}
		if previousRedirect != nil {
			return previousRedirect(req, via)
		}
		return nil
	}

	return &Client{
		baseURL: baseURL, orgID: cfg.OrgID, userID: cfg.UserID,
		bearerToken: cfg.BearerToken, timeout: timeout, httpClient: httpClient,
	}, nil
}

// DoJSON sends one request and decodes a bounded JSON object response. HTTP
// error statuses are returned to the caller with their decoded API envelope.
func (c *Client) DoJSON(ctx context.Context, method, path string, body any) (int, map[string]any, error) {
	status, raw, err := c.do(ctx, method, path, body)
	if err != nil {
		return status, nil, err
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return status, nil, fmt.Errorf("decode API response: %w", err)
	}
	if decoded == nil {
		return status, nil, errors.New("API response must be a JSON object")
	}
	return status, decoded, nil
}

// DoJSONArray sends one request and decodes the legacy unversioned list shape
// used by a small number of public routes. Keeping this separate preserves the
// fail-closed object contract for every API-envelope call.
func (c *Client) DoJSONArray(ctx context.Context, method, path string, body any) (int, []map[string]any, error) {
	status, raw, err := c.do(ctx, method, path, body)
	if err != nil {
		return status, nil, err
	}
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return status, nil, fmt.Errorf("decode API response: %w", err)
	}
	if decoded == nil {
		return status, nil, errors.New("API response must be a JSON array")
	}
	return status, decoded, nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	ref, err := url.ParseRequestURI(path)
	if err != nil || !strings.HasPrefix(path, "/") || ref.IsAbs() || ref.Host != "" {
		return 0, nil, errors.New("API path must be an absolute-path reference")
	}

	var payload []byte
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("encode API request: %w", err)
		}
	}

	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, method, c.baseURL.ResolveReference(ref).String(), bytes.NewReader(payload))
	if err != nil {
		return 0, nil, fmt.Errorf("create API request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if c.orgID != "" {
		request.Header.Set("x-org-id", c.orgID)
	}
	if c.bearerToken != "" {
		request.Header.Set("Authorization", "Bearer "+c.bearerToken)
	} else if c.userID != "" {
		request.Header.Set("x-user-id", c.userID)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("API request failed: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return response.StatusCode, nil, fmt.Errorf("read API response: %w", err)
	}
	if int64(len(raw)) > MaxResponseBytes {
		return response.StatusCode, nil, fmt.Errorf("API response exceeds %d bytes", MaxResponseBytes)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return response.StatusCode, nil, errors.New("API response is empty")
	}
	return response.StatusCode, raw, nil
}
