// FetchHTTPTarget — the contract's fetchHttpTarget layering for Go: the
// SAME SSRF validation, DNS-pinned dial, per-hop revalidation, origin
// credential stripping, timeout, byte cap, and redirect bound as the
// `http` node executor, but WITHOUT the non-2xx failure policy — callers
// (integration tools, report delivery) own their envelope and need the
// status + body of error responses. No vendor SDK ever dials on its own:
// every integration egress goes through here.
package executors

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// FetchOptions bound one outbound call.
type FetchOptions struct {
	Method           string
	Headers          map[string]string
	Body             []byte
	TimeoutMs        int
	MaxResponseBytes int
	MaxRedirects     int
	// MaxRedirectsSet distinguishes an explicit zero-hop policy from the
	// zero-value default. Existing fixed-endpoint integrations normally use
	// DisableRedirects; generic callers set this bit when the input contains
	// maxRedirects, including zero.
	MaxRedirectsSet bool
	// DisableRedirects is for credential-bearing fixed-endpoint calls. A
	// 307/308 otherwise replays the request body — including form secrets —
	// to the redirect target even when credential headers are stripped.
	DisableRedirects bool
}

// FetchResult carries the upstream answer; Ok is the plain 2xx bit.
// ContentType feeds the buffered-JSON projection (declared JSON only).
type FetchResult struct {
	StatusCode  int
	Body        string
	Ok          bool
	ContentType string
}

// FetchHTTPTarget performs one guarded outbound HTTP call.
func FetchHTTPTarget(ctx context.Context, rawURL string, opts FetchOptions) (FetchResult, error) {
	executor := &httpExecutor{opts: normalizeHTTPOptions(HTTPOptions{})}
	method := strings.ToUpper(opts.Method)
	if method == "" {
		method = "GET"
	}
	timeoutMs := opts.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = httpDefaultTimeoutMs
	}
	if timeoutMs > httpMaxTimeoutMs {
		return FetchResult{}, fmt.Errorf("HTTP timeoutMs exceeds platform maximum %d", httpMaxTimeoutMs)
	}
	maxBytes := opts.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = httpDefaultMaxBytes
	}
	if maxBytes > httpMaxResponseBytes {
		return FetchResult{}, fmt.Errorf("HTTP maxResponseBytes exceeds platform maximum %d", httpMaxResponseBytes)
	}
	maxRedirects := opts.MaxRedirects
	if maxRedirects == 0 && !opts.MaxRedirectsSet {
		maxRedirects = httpDefaultMaxRedirect
	}
	if maxRedirects < 0 || maxRedirects > httpMaxRedirects {
		return FetchResult{}, fmt.Errorf("HTTP maxRedirects must be between 0 and %d", httpMaxRedirects)
	}

	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	target, err := executor.validate(ctx, rawURL, pins)
	if err != nil {
		return FetchResult{}, err
	}
	transport := executor.newTransport(pins)
	client := &http.Client{
		Transport:     transport,
		Timeout:       time.Duration(timeoutMs) * time.Millisecond,
		CheckRedirect: executor.redirectPolicy(pins, maxRedirects, opts.DisableRedirects),
	}
	defer transport.CloseIdleConnections()

	var bodyReader io.Reader
	if opts.Body != nil {
		bodyReader = bytes.NewReader(opts.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), bodyReader)
	if err != nil {
		return FetchResult{}, err
	}
	for name, value := range opts.Headers {
		req.Header.Set(name, value)
	}
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "Client.Timeout") {
			return FetchResult{}, fmt.Errorf("HTTP request timed out after %dms", timeoutMs) //nolint:staticcheck // contract message is the wire contract
		}
		return FetchResult{}, err
	}
	defer func() { _ = res.Body.Close() }()
	limited := io.LimitReader(res.Body, int64(maxBytes)+1)
	bodyBytes, err := io.ReadAll(limited)
	if err != nil {
		return FetchResult{}, err
	}
	if len(bodyBytes) > maxBytes {
		return FetchResult{}, fmt.Errorf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", len(bodyBytes), maxBytes) //nolint:staticcheck // contract message is the wire contract
	}
	return FetchResult{
		StatusCode:  res.StatusCode,
		Body:        string(bodyBytes),
		Ok:          res.StatusCode >= 200 && res.StatusCode < 300,
		ContentType: res.Header.Get("Content-Type"),
	}, nil
}
