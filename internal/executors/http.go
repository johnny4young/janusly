// The http node executor with the contract's SSRF posture: validate the
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
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/johnny4young/janusly/internal/httpcontract"
)

// HTTP bounds mirror the contract defaults.
const (
	httpDefaultTimeoutMs = httpcontract.DefaultTimeoutMS
	// A node-level override may lower the resolved tenant bound, but it may
	// never remove the deadline or hold a worker through an entire deploy.
	httpMaxTimeoutMs       = httpcontract.MaxTimeoutMS
	httpDefaultMaxBytes    = httpcontract.DefaultMaxResponseBytes
	httpMaxResponseBytes   = httpcontract.MaxResponseBytes
	httpDefaultMaxRedirect = httpcontract.DefaultMaxRedirects
	httpMaxRedirects       = httpcontract.MaxRedirects
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

// isPrivateIPv4 ports the contract's class table: 0/8, 10/8, 127/8, CGNAT
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
// including IPv4-mapped IPv6 forms and the contract's IPv6 set (::1, ::,
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
		return nil, fmt.Errorf("Pinned HTTP target IP is private and blocked: %s", pinned) //nolint:staticcheck // contract message is the wire contract
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
		return nil, fmt.Errorf("HTTP target url is required") //nolint:staticcheck // contract message is the wire contract
	}
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, fmt.Errorf("Unsupported HTTP target protocol: %s:", target.Scheme) //nolint:staticcheck // contract message is the wire contract
	}
	if e.opts.AllowPrivate() {
		// The explicit bypass mirrors the contract: no pinning, ordinary
		// resolution — the operator opted out of the whole posture.
		return target, nil
	}

	hostname := target.Hostname()
	normalized := normalizeHostname(hostname)
	if privateHostnames[normalized] || strings.HasSuffix(normalized, ".localhost") {
		return nil, fmt.Errorf("HTTP target is private and blocked: %s", hostname) //nolint:staticcheck // contract message is the wire contract
	}
	if isPrivateHost(normalized) {
		return nil, fmt.Errorf("HTTP target is private and blocked: %s", hostname) //nolint:staticcheck // contract message is the wire contract
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
	if slices.ContainsFunc(ips, IsPrivateIP) {
		return nil, fmt.Errorf("HTTP target resolves to a private address and is blocked: %s", hostname) //nolint:staticcheck // contract message is the wire contract
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("HTTP target did not resolve to any address: %s", hostname) //nolint:staticcheck // contract message is the wire contract
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
	// Details carries bounded structured diagnostics that operators need to
	// understand the failure without reconstructing executor-local state.
	Details any
	// WriteSide marks an error raised after external effects may have
	// happened; the engine's retry ladder refuses whole-node retries.
	WriteSide bool
}

func (e *ExecErrorShape) Error() string { return e.Message }

// ErrorName exposes the contract error name (e.g. HttpResponseError).
func (e *ExecErrorShape) ErrorName() string { return e.Name }

// ErrorCode exposes the classification code (e.g. E_HTTP_STATUS).
func (e *ExecErrorShape) ErrorCode() string { return e.Code }

// ErrorStatusCode exposes the HTTP status for Nxx classification.
func (e *ExecErrorShape) ErrorStatusCode() int { return e.StatusCode }

// ErrorDetails exposes bounded structured diagnostics for persistence.
func (e *ExecErrorShape) ErrorDetails() any { return e.Details }

// httpMethodWriteSide is deliberately a safe-method allowlist. Extension and
// unknown methods can mutate external state and therefore cannot inherit the
// retry posture of GET merely because they were absent from a denylist.
func httpMethodWriteSide(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "", "GET", "HEAD", "OPTIONS":
		return false
	default:
		return true
	}
}

// markHTTPWriteSide preserves a rich error's classification while attaching
// the retry-stopping marker. client.Do is the ambiguity boundary: once it is
// entered, a mutating request may have reached the peer even when no response
// (or only a partial response) reaches Janusly.
func markHTTPWriteSide(err error) error {
	if err == nil {
		return nil
	}
	var shape *ExecErrorShape
	if errors.As(err, &shape) {
		return &ExecErrorShape{
			Message: err.Error(), Name: shape.Name, Code: shape.Code,
			StatusCode: shape.StatusCode, Details: shape.Details, WriteSide: true,
		}
	}
	return &ExecErrorShape{Message: err.Error(), WriteSide: true}
}

func (e *httpExecutor) execute(ctx context.Context, in Input) (result any, execErr error) {
	resolvedConfig, err := httpcontract.ResolveNodeConfig(in.Config, false)
	if err != nil {
		return nil, err
	}
	rawURL := resolvedConfig.URL
	method := resolvedConfig.Method
	// The sandbox gate: a validation replay skips write-side methods —
	// read-side GET/HEAD still execute so validation produces real signal.
	if in.DryRun && method != "GET" && method != "HEAD" && method != "OPTIONS" {
		return map[string]any{
			"dryRun": true, "skipped": true, "reason": "validation_dry_run",
			"method": method,
		}, nil
	}
	// Bound precedence: node config → tenant defaults (org config/env,
	// resolved by the dispatcher) → platform constants.
	resolvedBounds := httpcontract.Normalize(in.HTTPBounds)
	timeoutMs := resolvedBounds.TimeoutMs
	maxBytes := resolvedBounds.MaxResponseBytes
	maxRedirects := resolvedBounds.MaxRedirects
	if resolvedConfig.MaxResponseBytes != nil {
		maxBytes = *resolvedConfig.MaxResponseBytes
	}
	if resolvedConfig.MaxRedirects != nil {
		maxRedirects = *resolvedConfig.MaxRedirects
	}
	if resolvedConfig.TimeoutMS != nil {
		timeoutMs = float64(*resolvedConfig.TimeoutMS)
	}

	pins := &pinnedDialer{byHost: map[string]net.IP{}}
	target, err := e.validate(ctx, rawURL, pins)
	if err != nil {
		return nil, err
	}

	transport := e.newTransport(pins)
	client := &http.Client{
		Transport:     transport,
		Timeout:       time.Duration(timeoutMs) * time.Millisecond,
		CheckRedirect: e.redirectPolicy(pins, maxRedirects, false),
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
	for name, value := range resolvedConfig.Headers {
		req.Header.Set(name, value)
	}

	requestDispatched := true
	defer func() {
		if execErr != nil && requestDispatched && httpMethodWriteSide(method) {
			execErr = markHTTPWriteSide(execErr)
		}
	}()
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
		return nil, fmt.Errorf("HTTP response exceeds maxResponseBytes (Content-Length %d > cap %d)", res.ContentLength, maxBytes) //nolint:staticcheck // contract message is the wire contract
	}

	// Streaming opt-in: consume the body into a bounded preview instead of
	// buffering it whole. The persisted output is JSON-safe — a string
	// preview plus counters, never a live stream and never JSON-projected.
	if resolvedConfig.BodyMode == "stream" {
		previewCap := resolvedBounds.StreamPreviewBytes
		if resolvedConfig.StreamPreviewBytes != nil {
			previewCap = *resolvedConfig.StreamPreviewBytes
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
		return nil, fmt.Errorf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", len(bodyBytes), maxBytes) //nolint:staticcheck // contract message is the wire contract
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
	maps.Copy(output, projectHTTPJSON(bodyBytes, res.Header.Get("Content-Type")))
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

// consumeStreamToPreview drains the body counting every byte (the response
// byte cap still aborts mid-stream) while buffering only the first
// previewCap bytes, mirroring the contract's consumeStreamToPreview.
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
				return "", 0, true, fmt.Errorf("HTTP response exceeds maxResponseBytes after %d bytes (cap %d)", total, maxBytes) //nolint:staticcheck // contract message is the wire contract
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

// redirectPolicy is the ONE CheckRedirect every outbound client shares — the
// SSRF posture on redirects must not diverge between the http node, fetch,
// and csv fetch, so it lives in one place:
//
//   - a hop budget;
//   - every hop revalidates and re-pins — a 302 to the metadata endpoint
//     dies here, not at the socket;
//   - fetch-spec credential stripping, ORIGIN-based like the contract's
//     manual hops. Go's own redirect logic compares DOMAINS (same host or
//     subdomain keeps Authorization/Cookie on any port, and never touches
//     Proxy-Authorization), so a same-host port change, a scheme downgrade,
//     or a subdomain hop would otherwise forward the credential. Same-origin
//     hops keep their headers.
//
// disableRedirects hands the first response back untouched, for
// credential-bearing fixed-endpoint calls that must never follow a hop.
func (e *httpExecutor) redirectPolicy(pins *pinnedDialer, maxRedirects int, disableRedirects bool) func(*http.Request, []*http.Request) error {
	return func(req *http.Request, via []*http.Request) error {
		if disableRedirects {
			return http.ErrUseLastResponse
		}
		if len(via) > maxRedirects {
			return fmt.Errorf("HTTP redirect limit exceeded; last hop %s -> %s", via[len(via)-1].URL, req.URL) //nolint:staticcheck // contract message is the wire contract
		}
		if _, err := e.validate(req.Context(), req.URL.String(), pins); err != nil {
			return err
		}
		if !sameOrigin(via[len(via)-1].URL, req.URL) {
			for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie"} {
				req.Header.Del(name)
			}
		}
		return nil
	}
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
