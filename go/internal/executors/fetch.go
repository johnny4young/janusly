// FetchHTTPTarget — the reference's fetchHttpTarget layering for Go: the
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
}

// FetchResult carries the upstream answer; Ok is the plain 2xx bit.
type FetchResult struct {
	StatusCode int
	Body       string
	Ok         bool
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
	maxBytes := opts.MaxResponseBytes
	if maxBytes <= 0 {
		maxBytes = httpDefaultMaxBytes
	}
	maxRedirects := opts.MaxRedirects
	if maxRedirects <= 0 {
		maxRedirects = httpDefaultMaxRedirect
	}

	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	target, err := executor.validate(ctx, rawURL, pins)
	if err != nil {
		return FetchResult{}, err
	}
	transport := executor.newTransport(pins)
	client := &http.Client{
		Transport: transport,
		Timeout:   time.Duration(timeoutMs) * time.Millisecond,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("HTTP redirect limit exceeded; last hop %s -> %s", via[len(via)-1].URL, req.URL) //nolint:staticcheck // reference message is the wire contract
			}
			if _, err := executor.validate(req.Context(), req.URL.String(), pins); err != nil {
				return err
			}
			if !sameOrigin(via[len(via)-1].URL, req.URL) {
				for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
					req.Header.Del(name)
				}
			}
			return nil
		},
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
			return FetchResult{}, fmt.Errorf("HTTP request timed out after %dms", timeoutMs) //nolint:staticcheck // reference message is the wire contract
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
		return FetchResult{}, fmt.Errorf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", len(bodyBytes), maxBytes) //nolint:staticcheck // reference message is the wire contract
	}
	return FetchResult{
		StatusCode: res.StatusCode,
		Body:       string(bodyBytes),
		Ok:         res.StatusCode >= 200 && res.StatusCode < 300,
	}, nil
}
