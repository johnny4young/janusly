// Package httpcontract owns the process-wide outbound HTTP resource limits.
// Keeping these values outside the executor and org-config packages prevents
// the authoring, tenant-default, and runtime boundaries from drifting.
package httpcontract

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/grammar"
	"golang.org/x/net/http/httpguts"
)

const (
	DefaultTimeoutMS        = 30_000
	MaxTimeoutMS            = 600_000
	DefaultMaxResponseBytes = 1_000_000
	// MaxResponseBytes admits the documented 50 MB streaming use case while
	// retaining a process-wide ceiling for buffered responses and persisted
	// node output.
	MaxResponseBytes     = 64 * 1_048_576
	DefaultMaxRedirects  = 5
	MaxRedirects         = 20
	DefaultStreamPreview = 65_536
	MinStreamPreview     = 1_024
	MaxStreamPreview     = 1_048_576
	MaxURLBytes          = 4_096
	MaxHeaderCount       = 64
	MaxHeaderNameBytes   = 128
	MaxHeaderValueBytes  = 8 << 10
	MaxHeaderBytes       = 32 << 10
	MaxRequestBodyBytes  = 2 << 20
)

// Bounds are the tenant-effective outbound HTTP defaults.
type Bounds struct {
	TimeoutMs          float64
	MaxResponseBytes   int
	MaxRedirects       int
	StreamPreviewBytes int
}

// NodeConfigErrorKind lets workflow validation preserve the historic missing
// URL code while reporting every other HTTP shape failure as invalid config.
type NodeConfigErrorKind string

const (
	NodeConfigMissingURL NodeConfigErrorKind = "missing_url"
	NodeConfigInvalid    NodeConfigErrorKind = "invalid_config"
)

type NodeConfigError struct {
	Kind    NodeConfigErrorKind
	Message string
}

func (e *NodeConfigError) Error() string { return e.Message }

// NodeConfig is the concrete HTTP subset consumed by the executor. Optional
// pointer bounds distinguish an omitted node override from an explicit zero.
type NodeConfig struct {
	URL                string
	Method             string
	Headers            map[string]string
	TimeoutMS          *int
	MaxResponseBytes   *int
	MaxRedirects       *int
	BodyMode           string
	StreamPreviewBytes *int
}

var methodTokenPattern = regexp.MustCompile(`^[!#$%&'*+\-.^_` + "`" + `|~0-9A-Za-z]+$`)

var forbiddenRequestHeaders = map[string]bool{
	"connection": true, "content-length": true, "host": true,
	"proxy-connection": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true,
}

func validateHeaders(headers map[string]any) (map[string]string, error) {
	if len(headers) > MaxHeaderCount {
		return nil, invalidNodeConfig(fmt.Sprintf("http.headers supports at most %d entries", MaxHeaderCount))
	}
	resolved := make(map[string]string, len(headers))
	seen := make(map[string]bool, len(headers))
	total := 0
	for name, rawValue := range headers {
		value, ok := rawValue.(string)
		if !ok {
			return nil, invalidNodeConfig(fmt.Sprintf("http.headers[%q] must be a string", name))
		}
		lower := strings.ToLower(name)
		total += len(name) + len(value)
		if name == "" || len(name) > MaxHeaderNameBytes || len(value) > MaxHeaderValueBytes ||
			!httpguts.ValidHeaderFieldName(name) || !httpguts.ValidHeaderFieldValue(value) {
			return nil, invalidNodeConfig("http.headers must use valid bounded HTTP names and values")
		}
		if forbiddenRequestHeaders[lower] {
			return nil, invalidNodeConfig(fmt.Sprintf("http.headers[%q] is controlled by the transport", name))
		}
		if seen[lower] {
			return nil, invalidNodeConfig("http.headers must be unique case-insensitively")
		}
		seen[lower] = true
		resolved[name] = value
	}
	if total > MaxHeaderBytes {
		return nil, invalidNodeConfig(fmt.Sprintf("http.headers exceeds %d bytes", MaxHeaderBytes))
	}
	return resolved, nil
}

// ResolveNodeConfig is the single shape/bounds grammar used at workflow-save
// and executor time. Save-time may accept one whole template reference for a
// value whose concrete type is checked again after rendering.
func ResolveNodeConfig(config map[string]any, allowWholeTemplates bool) (NodeConfig, error) {
	resolved := NodeConfig{Method: "GET", Headers: map[string]string{}, BodyMode: "buffer"}
	rawURL, present := config["url"]
	urlText, ok := rawURL.(string)
	if !present || !ok || strings.TrimSpace(urlText) == "" {
		return NodeConfig{}, &NodeConfigError{Kind: NodeConfigMissingURL, Message: "HTTP node requires config.url"}
	}
	if urlText != strings.TrimSpace(urlText) || !utf8.ValidString(urlText) || len(urlText) > MaxURLBytes {
		return NodeConfig{}, invalidNodeConfig(fmt.Sprintf("http.url must be trimmed UTF-8 of at most %d bytes", MaxURLBytes))
	}
	containsTemplate := strings.Contains(urlText, "{{") && strings.Contains(urlText, "}}")
	if !allowWholeTemplates || !containsTemplate {
		parsed, parseErr := url.ParseRequestURI(urlText)
		if parseErr != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || strings.Contains(urlText, "#") ||
			(parsed.Scheme != "http" && parsed.Scheme != "https") {
			return NodeConfig{}, invalidNodeConfig("http.url must be an absolute HTTP(S) URL without userinfo or fragments")
		}
	}
	resolved.URL = urlText

	if raw, present := config["method"]; present {
		method, ok := raw.(string)
		if !ok {
			return NodeConfig{}, invalidNodeConfig("http.method must be a string")
		}
		method = strings.TrimSpace(method)
		if method != "" {
			if allowWholeTemplates && isWholeTemplate(method) {
				resolved.Method = method
			} else if !methodTokenPattern.MatchString(method) {
				return NodeConfig{}, invalidNodeConfig("http.method must be a valid HTTP method token")
			} else {
				resolved.Method = strings.ToUpper(method)
			}
		}
	}

	if raw, present := config["headers"]; present {
		if text, ok := raw.(string); ok && allowWholeTemplates && isWholeTemplate(text) {
			// The rendered executor pass validates the resulting object.
		} else {
			headers, ok := raw.(map[string]any)
			if !ok || headers == nil {
				return NodeConfig{}, invalidNodeConfig("http.headers must be an object with string values")
			}
			resolvedHeaders, err := validateHeaders(headers)
			if err != nil {
				return NodeConfig{}, err
			}
			resolved.Headers = resolvedHeaders
		}
	}

	for _, spec := range []struct {
		field       string
		minimum     int
		maximum     int
		destination **int
	}{
		{field: "timeoutMs", minimum: 1, maximum: MaxTimeoutMS, destination: &resolved.TimeoutMS},
		{field: "maxResponseBytes", minimum: 1, maximum: MaxResponseBytes, destination: &resolved.MaxResponseBytes},
		{field: "maxRedirects", minimum: 0, maximum: MaxRedirects, destination: &resolved.MaxRedirects},
		{field: "streamPreviewBytes", minimum: MinStreamPreview, maximum: MaxStreamPreview, destination: &resolved.StreamPreviewBytes},
	} {
		raw, present := config[spec.field]
		if !present {
			continue
		}
		if text, ok := raw.(string); ok && allowWholeTemplates && isWholeTemplate(text) {
			continue
		}
		value, valid := WholeNumber(raw, spec.minimum, spec.maximum)
		if !valid {
			return NodeConfig{}, invalidNodeConfig(fmt.Sprintf("http.%s must be an integer between %d and %d", spec.field, spec.minimum, spec.maximum))
		}
		valueCopy := value
		*spec.destination = &valueCopy
	}

	if raw, present := config["bodyMode"]; present {
		mode, ok := raw.(string)
		if !ok {
			return NodeConfig{}, invalidNodeConfig("http.bodyMode must be buffer or stream")
		}
		if allowWholeTemplates && isWholeTemplate(mode) {
			resolved.BodyMode = mode
		} else if mode != "buffer" && mode != "stream" {
			return NodeConfig{}, invalidNodeConfig("http.bodyMode must be buffer or stream")
		} else {
			resolved.BodyMode = mode
		}
	}
	return resolved, nil
}

func invalidNodeConfig(message string) *NodeConfigError {
	return &NodeConfigError{Kind: NodeConfigInvalid, Message: message}
}

func isWholeTemplate(value string) bool {
	_, whole := grammar.WholeTemplateReference(value)
	return whole
}

// WholeNumber accepts the concrete numeric representations used by decoded
// workflow JSON and internal callers, rejecting non-finite, fractional, and
// out-of-range values before an unsafe int conversion.
func WholeNumber(raw any, minimum, maximum int) (int, bool) {
	var value float64
	switch number := raw.(type) {
	case float64:
		value = number
	case float32:
		value = float64(number)
	case int:
		value = float64(number)
	case int8:
		value = float64(number)
	case int16:
		value = float64(number)
	case int32:
		value = float64(number)
	case int64:
		value = float64(number)
	case uint:
		value = float64(number)
	case uint8:
		value = float64(number)
	case uint16:
		value = float64(number)
	case uint32:
		value = float64(number)
	case uint64:
		value = float64(number)
	case json.Number:
		parsed, err := number.Float64()
		if err != nil {
			return 0, false
		}
		value = parsed
	default:
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value ||
		value < float64(minimum) || value > float64(maximum) {
		return 0, false
	}
	return int(value), true
}

// Normalize returns safe defaults for malformed internal seams. Public tenant
// and workflow writes reject invalid values earlier; this remains the final
// defense for legacy rows and hand-built executor inputs.
func Normalize(input *Bounds) Bounds {
	resolved := Bounds{
		TimeoutMs: DefaultTimeoutMS, MaxResponseBytes: DefaultMaxResponseBytes,
		MaxRedirects: DefaultMaxRedirects, StreamPreviewBytes: DefaultStreamPreview,
	}
	if input == nil {
		return resolved
	}
	if value, ok := WholeNumber(input.TimeoutMs, 1, MaxTimeoutMS); ok {
		resolved.TimeoutMs = float64(value)
	}
	if value, ok := WholeNumber(input.MaxResponseBytes, 1, MaxResponseBytes); ok {
		resolved.MaxResponseBytes = value
	}
	if value, ok := WholeNumber(input.MaxRedirects, 0, MaxRedirects); ok {
		resolved.MaxRedirects = value
	}
	if value, ok := WholeNumber(input.StreamPreviewBytes, MinStreamPreview, MaxStreamPreview); ok {
		resolved.StreamPreviewBytes = value
	}
	return resolved
}
