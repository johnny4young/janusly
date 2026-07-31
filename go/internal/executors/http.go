// The http node executor with the reference's SSRF posture: validate the
// target's scheme and hostname, resolve DNS ONCE through an injectable
// resolver, refuse loopback/private/link-local/metadata classes, and dial
// the exact validated address — so the rebinding class of bug (public IP at
// validation, private at connect) cannot occur. Every redirect hop
// revalidates and re-pins. Ported from http-policy.ts with its verbatim
// rejection messages; ALLOW_PRIVATE_HTTP_TARGETS=true is the same explicit
// bypass.
package executors

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// HTTP bounds mirror the reference defaults.
const (
	httpDefaultTimeoutMs   = 30_000
	httpDefaultMaxBytes    = 1_000_000
	httpDefaultMaxRedirect = 5
	httpJSONProjectionMax  = 64 * 1024
)

// ResolveFunc looks a hostname up; injectable so tests can simulate any DNS
// behavior, including a rebinding resolver.
type ResolveFunc func(ctx context.Context, host string) ([]net.IP, error)

// HTTPOptions configure the executor's security seams.
type HTTPOptions struct {
	// Resolve defaults to the system resolver.
	Resolve ResolveFunc
	// AllowPrivate defaults to the ALLOW_PRIVATE_HTTP_TARGETS env flag.
	AllowPrivate func() bool
}

var privateHostnames = map[string]bool{"localhost": true, "localhost.localdomain": true}

func normalizeHostname(hostname string) string {
	h := strings.ToLower(hostname)
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	return strings.TrimSuffix(h, ".")
}

// isPrivateIPv4 ports the reference's class table: 0/8, 10/8, 127/8, CGNAT
// 100.64/10, link-local 169.254/16 (metadata included), 172.16/12,
// 192.168/16, and everything from 224 up (multicast + reserved).
func isPrivateIPv4(a, b byte) bool {
	switch {
	case a == 0 || a == 10 || a == 127:
		return true
	case a == 100 && b >= 64 && b <= 127:
		return true
	case a == 169 && b == 254:
		return true
	case a == 172 && b >= 16 && b <= 31:
		return true
	case a == 192 && b == 168:
		return true
	case a >= 224:
		return true
	default:
		return false
	}
}

// IsPrivateIP reports whether the address falls in a blocked class,
// including IPv4-mapped IPv6 forms and the reference's IPv6 set (::1, ::,
// ULA fc/fd, link-local fe80, multicast ff).
func IsPrivateIP(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		return isPrivateIPv4(v4[0], v4[1])
	}
	text := strings.ToLower(ip.String())
	return text == "::1" || text == "::" ||
		strings.HasPrefix(text, "fc") || strings.HasPrefix(text, "fd") ||
		strings.HasPrefix(text, "fe80:") || strings.HasPrefix(text, "ff")
}

// isPrivateHost classifies a hostname that is itself an IP literal.
func isPrivateHost(host string) bool {
	ip := net.ParseIP(normalizeHostname(host))
	return ip != nil && IsPrivateIP(ip)
}

// pinnedDialer resolves nothing at dial time: it dials exactly the address
// validated for each host, and refuses hosts nobody validated.
type pinnedDialer struct {
	mu     sync.Mutex
	byHost map[string]net.IP
}

func (p *pinnedDialer) pin(host string, ip net.IP) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.byHost[normalizeHostname(host)] = ip
}

func (p *pinnedDialer) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	pinned, ok := p.byHost[normalizeHostname(host)]
	p.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("refusing to dial unvalidated host: %s", host)
	}
	if IsPrivateIP(pinned) {
		// Defence in depth — the validation above already refused it.
		return nil, fmt.Errorf("Pinned HTTP target IP is private and blocked: %s", pinned) //nolint:staticcheck // reference message is the wire contract
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, network, net.JoinHostPort(pinned.String(), port))
}

type httpExecutor struct {
	opts HTTPOptions
}

// NewHTTPExecutor builds the http node executor with injectable seams.
func NewHTTPExecutor(opts HTTPOptions) Func {
	executor := &httpExecutor{opts: normalizeHTTPOptions(opts)}
	return executor.execute
}

// normalizeHTTPOptions fills the production defaults for the SSRF seams.
func normalizeHTTPOptions(opts HTTPOptions) HTTPOptions {
	if opts.Resolve == nil {
		opts.Resolve = func(ctx context.Context, host string) ([]net.IP, error) {
			addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			ips := make([]net.IP, 0, len(addrs))
			for _, a := range addrs {
				ips = append(ips, a.IP)
			}
			return ips, nil
		}
	}
	if opts.AllowPrivate == nil {
		opts.AllowPrivate = func() bool { return os.Getenv("ALLOW_PRIVATE_HTTP_TARGETS") == "true" }
	}
	return opts
}

// validate checks scheme and hostname classes and, for public targets,
// resolves and pins the first validated address.
func (e *httpExecutor) validate(ctx context.Context, rawURL string, pins *pinnedDialer) (*url.URL, error) {
	if strings.TrimSpace(rawURL) == "" {
		return nil, fmt.Errorf("HTTP target url is required") //nolint:staticcheck // reference message is the wire contract
	}
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("Unsupported HTTP target protocol: %s:", target.Scheme) //nolint:staticcheck // reference message is the wire contract
	}
	if e.opts.AllowPrivate() {
		// The explicit bypass mirrors the reference: no pinning, ordinary
		// resolution — the operator opted out of the whole posture.
		return target, nil
	}

	hostname := target.Hostname()
	normalized := normalizeHostname(hostname)
	if privateHostnames[normalized] || strings.HasSuffix(normalized, ".localhost") {
		return nil, fmt.Errorf("HTTP target is private and blocked: %s", hostname) //nolint:staticcheck // reference message is the wire contract
	}
	if isPrivateHost(normalized) {
		return nil, fmt.Errorf("HTTP target is private and blocked: %s", hostname) //nolint:staticcheck // reference message is the wire contract
	}
	if ip := net.ParseIP(normalized); ip != nil {
		pins.pin(hostname, ip)
		return target, nil
	}
	ips, err := e.opts.Resolve(ctx, normalized)
	if err != nil {
		return nil, &ExecErrorShape{
			Message: fmt.Sprintf("HTTP target did not resolve to any address: %s", hostname),
			Code:    "ENOTFOUND",
		}
	}
	for _, ip := range ips {
		if IsPrivateIP(ip) {
			return nil, fmt.Errorf("HTTP target resolves to a private address and is blocked: %s", hostname) //nolint:staticcheck // reference message is the wire contract
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("HTTP target did not resolve to any address: %s", hostname) //nolint:staticcheck // reference message is the wire contract
	}
	// Pin the first validated address: the dialer never consults DNS again.
	pins.pin(hostname, ips[0])
	return target, nil
}

// ExecErrorShape is a structured executor error carried by name/code/status
// so the retry ladder can classify it. Defined here to keep the executors
// package engine-independent; the engine reads it via the RichError
// interface.
type ExecErrorShape struct {
	Message    string
	Name       string
	Code       string
	StatusCode int
}

func (e *ExecErrorShape) Error() string { return e.Message }

// ErrorName exposes the reference error name (e.g. HttpResponseError).
func (e *ExecErrorShape) ErrorName() string { return e.Name }

// ErrorCode exposes the classification code (e.g. E_HTTP_STATUS).
func (e *ExecErrorShape) ErrorCode() string { return e.Code }

// ErrorStatusCode exposes the HTTP status for Nxx classification.
func (e *ExecErrorShape) ErrorStatusCode() int { return e.StatusCode }

func (e *httpExecutor) execute(ctx context.Context, in Input) (any, error) {
	rawURL, _ := in.Config["url"].(string)
	method := "GET"
	if m, ok := in.Config["method"].(string); ok && m != "" {
		method = strings.ToUpper(m)
	}
	// Bound precedence: node config → tenant defaults (org config/env,
	// resolved by the dispatcher) → platform constants.
	timeoutMs := float64(httpDefaultTimeoutMs)
	maxBytes := httpDefaultMaxBytes
	maxRedirects := httpDefaultMaxRedirect
	if in.HTTPBounds != nil {
		timeoutMs = in.HTTPBounds.TimeoutMs
		maxBytes = in.HTTPBounds.MaxResponseBytes
		maxRedirects = in.HTTPBounds.MaxRedirects
	}
	if v, ok := in.Config["timeoutMs"].(float64); ok {
		timeoutMs = v
	}
	if v, ok := in.Config["maxResponseBytes"].(float64); ok {
		maxBytes = int(v)
	}
	if v, ok := in.Config["maxRedirects"].(float64); ok {
		maxRedirects = int(v)
	}

	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	target, err := e.validate(ctx, rawURL, pins)
	if err != nil {
		return nil, err
	}

	transport := e.newTransport(pins)
	client := &http.Client{
		Transport: transport,
		Timeout:   time.Duration(timeoutMs) * time.Millisecond,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("HTTP redirect limit exceeded; last hop %s -> %s", via[len(via)-1].URL, req.URL) //nolint:staticcheck // reference message is the wire contract
			}
			// Every hop revalidates and re-pins — a 302 to the metadata
			// endpoint dies here, not at the socket.
			if _, err := e.validate(req.Context(), req.URL.String(), pins); err != nil {
				return err
			}
			// Fetch-spec credential stripping, ORIGIN-based like the
			// reference's manual hops: Go's own redirect logic compares
			// DOMAINS (same host or subdomain keeps Authorization/Cookie on
			// any port, and never touches Proxy-Authorization) — so a
			// redirect to the same host on another port, a scheme
			// downgrade, or a subdomain hop would forward the credential.
			// Same-origin hops keep their headers.
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
	if body, present := in.Config["body"]; present {
		serialized, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("serialize request body: %w", err)
		}
		bodyReader = strings.NewReader(string(serialized))
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), bodyReader)
	if err != nil {
		return nil, err
	}
	if headers, ok := in.Config["headers"].(map[string]any); ok {
		for name, value := range headers {
			if s, ok := value.(string); ok {
				req.Header.Set(name, s)
			}
		}
	}

	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "Client.Timeout") {
			return nil, &ExecErrorShape{
				Message: fmt.Sprintf("HTTP request timed out after %dms", int(timeoutMs)),
				Name:    "NodeTimeoutError", Code: "ETIMEDOUT",
			}
		}
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()

	if res.ContentLength > int64(maxBytes) {
		return nil, fmt.Errorf("HTTP response exceeds maxResponseBytes (Content-Length %d > cap %d)", res.ContentLength, maxBytes) //nolint:staticcheck // reference message is the wire contract
	}

	// Streaming opt-in: consume the body into a bounded preview instead of
	// buffering it whole. The persisted output is JSON-safe — a string
	// preview plus counters, never a live stream and never JSON-projected.
	if mode, _ := in.Config["bodyMode"].(string); mode == "stream" {
		previewCap := streamPreviewDefault
		if in.HTTPBounds != nil && in.HTTPBounds.StreamPreviewBytes > 0 {
			previewCap = in.HTTPBounds.StreamPreviewBytes
		}
		if v, ok := in.Config["streamPreviewBytes"].(float64); ok {
			previewCap = int(math.Max(streamPreviewMin, math.Min(v, streamPreviewMax)))
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, &ExecErrorShape{
				Message: fmt.Sprintf("HTTP failed: %d", res.StatusCode),
				Name:    "HttpResponseError", Code: "E_HTTP_STATUS", StatusCode: res.StatusCode,
			}
		}
		preview, totalBytes, truncated, err := consumeStreamToPreview(res.Body, previewCap, maxBytes)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"statusCode": res.StatusCode, "ok": true, "body": preview,
			"streamed": true, "streamedBytes": totalBytes, "streamTruncated": truncated,
		}, nil
	}
	limited := io.LimitReader(res.Body, int64(maxBytes)+1)
	bodyBytes, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(bodyBytes) > maxBytes {
		return nil, fmt.Errorf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", len(bodyBytes), maxBytes) //nolint:staticcheck // reference message is the wire contract
	}

	ok := res.StatusCode >= 200 && res.StatusCode < 300
	if !ok {
		return nil, &ExecErrorShape{
			Message: fmt.Sprintf("HTTP failed: %d", res.StatusCode),
			Name:    "HttpResponseError", Code: "E_HTTP_STATUS", StatusCode: res.StatusCode,
		}
	}

	output := map[string]any{
		"statusCode": float64(res.StatusCode),
		"ok":         ok,
		"body":       string(bodyBytes),
	}
	for key, value := range projectHTTPJSON(bodyBytes, res.Header.Get("Content-Type")) {
		output[key] = value
	}
	return output, nil
}

// projectHTTPJSON adds the additive json fields only when the upstream
// explicitly declared a JSON media type: parsed under 64 KiB, a skip marker
// above it, and an observable-but-non-fatal error marker for invalid JSON.
func projectHTTPJSON(body []byte, contentType string) map[string]any {
	if !isJSONMediaType(contentType) {
		return nil
	}
	if len(body) > httpJSONProjectionMax {
		return map[string]any{"jsonParseSkipped": "body_too_large"}
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return map[string]any{"jsonParseError": true}
	}
	return map[string]any{"json": parsed}
}

func isJSONMediaType(value string) bool {
	if value == "" {
		return false
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	return mediaType == "application/json" ||
		(strings.HasPrefix(mediaType, "application/") && strings.HasSuffix(mediaType, "+json"))
}

// sameOrigin implements the fetch spec's origin comparison — scheme, host,
// and effective port (default 80/443 normalized).
func sameOrigin(a, b *url.URL) bool {
	return a.Scheme == b.Scheme && a.Hostname() == b.Hostname() && effectivePort(a) == effectivePort(b)
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

const (
	streamPreviewDefault = 65_536
	streamPreviewMin     = 1_024
	streamPreviewMax     = 1_048_576
)

// consumeStreamToPreview drains the body counting every byte (the response
// byte cap still aborts mid-stream) while buffering only the first
// previewCap bytes, mirroring the reference's consumeStreamToPreview.
func consumeStreamToPreview(body io.Reader, previewCap, maxBytes int) (string, int, bool, error) {
	preview := make([]byte, 0, min(previewCap, 64*1024))
	chunk := make([]byte, 32*1024)
	total := 0
	truncated := false
	for {
		n, err := body.Read(chunk)
		if n > 0 {
			total += n
			if total > maxBytes {
				return "", 0, true, fmt.Errorf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", total, maxBytes) //nolint:staticcheck // reference message is the wire contract
			}
			if len(preview) < previewCap {
				take := min(n, previewCap-len(preview))
				preview = append(preview, chunk[:take]...)
				if take < n {
					truncated = true
				}
			} else {
				truncated = true
			}
		}
		if err == io.EOF {
			return string(preview), total, truncated, nil
		}
		if err != nil {
			return "", 0, truncated, err
		}
	}
}

// NewPinnedHTTPClient validates rawURL under the same SSRF policy as the
// http node and returns an *http.Client whose transport dials ONLY the
// pinned, validated address (DNS-rebinding defense). Callers hand this
// client to SDKs (the MCP URL transports) so every fetch/redirect the SDK
// makes keeps the validated pin. AllowPrivate mode returns a plain client
// (the operator opted out of the posture).
func NewPinnedHTTPClient(ctx context.Context, rawURL string, opts HTTPOptions) (*http.Client, error) {
	executor := &httpExecutor{opts: normalizeHTTPOptions(opts)}
	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	if _, err := executor.validate(ctx, rawURL, pins); err != nil {
		return nil, err
	}
	return &http.Client{Transport: executor.newTransport(pins)}, nil
}

// newTransport builds the per-request transport with the pinned dialer
// (skipped when private targets are allowed — dev/test loopback).
func (e *httpExecutor) newTransport(pins *pinnedDialer) *http.Transport {
	transport := &http.Transport{
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		DisableKeepAlives: true,
	}
	if !e.opts.AllowPrivate() {
		transport.DialContext = pins.dial
	}
	return transport
}
