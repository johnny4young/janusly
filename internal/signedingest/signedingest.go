// Package signedingest holds what every signed CloudEvents receiver shares:
// the `t=<unix>,v1=<hex>` signature over "<t>.<body>", strict field sets,
// the secret scrubber and the refusal of secret-shaped identities.
package signedingest

import (
	"encoding/json"
	"regexp"

	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/webhooksig"
)

// ToleranceSeconds bounds the clock skew a signature may carry.
const ToleranceSeconds = 300

var hexSignature = regexp.MustCompile(`^[0-9a-f]{64}$`)

// VerifyTimestamped checks an HMAC-SHA256 `t=,v1=` header over "<t>.<body>"
// within ±ToleranceSeconds, in constant time.
func VerifyTimestamped(header, body, secret string, nowUnixSeconds int64) bool {
	timestampRaw, candidates := webhooksig.ParseHeader(header, "t", "v1")
	for _, candidate := range candidates {
		if !hexSignature.MatchString(candidate) {
			return false
		}
	}
	_, reason := webhooksig.Verify(timestampRaw, candidates, body, secret, nowUnixSeconds, webhooksig.Posture{
		Compose:          func(t, body string) string { return t + "." + body },
		ToleranceSeconds: ToleranceSeconds,
	})
	return reason == ""
}

// StrictObject decodes a JSON object and refuses any key outside allowed.
func StrictObject(raw []byte, allowed map[string]bool) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, false
	}
	for field := range fields {
		if !allowed[field] {
			return nil, false
		}
	}
	return fields, true
}

// IdentitySensitive reports identity values that look like secrets. Scrubbing
// would corrupt them, so the event must be refused instead.
func IdentitySensitive(values ...string) bool {
	for _, value := range values {
		if value != "" && signature.ScrubSecretShapes(value) != value {
			return true
		}
	}
	return false
}

// Scrub redacts secret shapes in every string of a decoded JSON value.
func Scrub(value any) any {
	switch typed := value.(type) {
	case string:
		return signature.ScrubSecretShapes(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, Scrub(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = Scrub(item)
		}
		return out
	default:
		return value
	}
}
