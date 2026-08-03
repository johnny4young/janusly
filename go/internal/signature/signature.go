// Error-signature normalizer — the pure clustering key, ported from the
// reference (packages/shared/src/error-signature.ts). First-match-wins
// rules produce a stable, human-readable label ("HTTP 401 on http node",
// "Missing secret: GITHUB_TOKEN") so the operator sees one cluster per
// problem instead of one DLQ row per occurrence.
//
// Hard safety property inherited from the reference: no secret value ever
// appears in a returned signature. Key-redaction happens upstream at the
// persistence chokepoint, but free-form error MESSAGES can carry
// token-shaped substrings; the secret-shape scrub here is the last line
// of defence.
//
// RE2 note: the reference's boundary lookaheads `(?=$|[^A-Za-z0-9])`
// are unsupported in RE2. For open-ended token bodies ({20,} greedy) the
// lookahead is redundant — greed already consumes every body char, so the
// next char is necessarily a boundary. Only the fixed-length shapes (AWS
// AKIA + Google AIza) need real emulation: a captured trailing boundary
// restored by the replacement.
package signature

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Result mirrors the reference's SignatureResult triple.
type Result struct {
	Signature      string `json:"signature"`
	Category       string `json:"category"`
	SuggestedOwner string `json:"suggestedOwner"`
}

// Context carries the failing node's identity into the rules.
type Context struct {
	NodeType string
	NodeID   string
	ToolName string
}

const fallbackSignatureMaxLength = 80

// secretShape pairs a token pattern with whether it captured a trailing
// boundary character that the replacement must restore.
type secretShape struct {
	pattern     *regexp.Regexp
	hasTrailing bool
}

var secretShapes = []secretShape{
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(sk-[A-Za-z0-9]{20,})`)},
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(ghp_[A-Za-z0-9]{20,})`)},
	// Fine-grained GitHub PAT: `_` in the body spans the internal separator
	// so the WHOLE token redacts, exactly like the reference.
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(github_pat_[A-Za-z0-9_]{20,})`)},
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(gh[ousr]_[A-Za-z0-9]{20,})`)},
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(xox[baprs]-[A-Za-z0-9-]{10,})`)},
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(AKIA[0-9A-Z]{16})($|[^A-Za-z0-9])`), hasTrailing: true},
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(AIza[A-Za-z0-9_-]{35})($|[^A-Za-z0-9])`), hasTrailing: true},
	{pattern: regexp.MustCompile(`(?i)(^|[^A-Za-z0-9])(Bearer\s+[A-Za-z0-9_\-.]{16,})`)},
	{pattern: regexp.MustCompile(`(^|[^A-Za-z0-9])(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`)},
}

// ScrubSecretShapes replaces every known token-shaped substring with
// "[redacted]", preserving the boundary characters around it.
func ScrubSecretShapes(input string) string {
	output := input
	for _, shape := range secretShapes {
		if shape.hasTrailing {
			output = shape.pattern.ReplaceAllString(output, "${1}[redacted]${3}")
		} else {
			output = shape.pattern.ReplaceAllString(output, "${1}[redacted]")
		}
	}
	return output
}

var (
	secretNotFoundPattern    = regexp.MustCompile(`(?i)secret\s+['"]?([\w\-.]+)['"]?\s+not\s+found`)
	envMissingPattern        = regexp.MustCompile(`(?i)Missing\s+(?:env(?:ironment)?\s+)?variable[: ]+([\w\-.]+)`)
	credentialMissingPattern = regexp.MustCompile(`(?i)credential\s+secret\s+missing\s+for\s+['"]?([\w\-.]+)`)
	missingSecretPattern     = regexp.MustCompile(`(?i)Missing\s+secret[: ]+['"]?([\w\-.]+)`)
	httpStatusPattern        = regexp.MustCompile(`(?i)\bHTTP\s+(\d{3})\b`)
	networkFailurePattern    = regexp.MustCompile(`(?i)\b(?:timeout|timed\s+out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))\b|getaddrinfo|did\s+not\s+resolve\s+to\s+any\s+address|fetch\s+failed`)
	parseErrorPattern        = regexp.MustCompile(`(?i)\b(?:invalid\s+JSON|is\s+not\s+valid\s+JSON|JSON\.parse|unexpected\s+token|unexpected\s+end\s+of\s+JSON|parse\s+error|in\s+JSON\s+at\s+position|expected\s+property\s+name)\b`)
	httpGuardPattern         = regexp.MustCompile(`(?i)\b(?:exceeds?\s+maxResponseBytes|redirect\s+limit\s+exceeded|target\s+is\s+private\s+and\s+blocked|resolves?\s+to\s+a\s+private\s+address|Unsupported\s+HTTP\s+target\s+protocol|response\s+(?:body\s+)?too\s+large)\b`)
	rateLimitPattern         = regexp.MustCompile(`(?i)\b(?:rate[_\s-]?limit(?:ed|s)?\s+(?:exceeded|reached|hit)|429\s+too\s+many\s+requests|too\s+many\s+requests)\b`)
	toolInvalidPattern       = regexp.MustCompile(`(?i)(?:tool\s+input\s+(?:did\s+not\s+match|invalid)|invalid\s+tool\s+input)(?:\s+for\s+['"]?([\w\-.]+)['"]?|[: ]+['"]?([\w\-.]+)['"]?)?`)
	toolNotFoundPattern      = regexp.MustCompile(`(?i)tool\s+['"]?([\w\-.]+)['"]?\s+not\s+found`)
	identifierUnsafePattern  = regexp.MustCompile(`[^\w\-.]`)
)

var aiProviderReasons = []struct {
	pattern *regexp.Regexp
	reason  string
}{
	{regexp.MustCompile(`(?i)\bcontext[_\s]?length(?:_exceeded)?\b|\bcontext\s+too\s+long\b`), "context too long"},
	{regexp.MustCompile(`(?i)\binsufficient_quota\b|\bquota\s+exceeded\b`), "quota exceeded"},
	{regexp.MustCompile(`(?i)\brate[_\s]?limit(?:ed|s)?\b`), "rate limit"},
	{regexp.MustCompile(`(?i)\bmodel\s+not\s+found\b|\bunknown\s+model\b`), "model not found"},
}

// Normalize extracts the stable cluster signature from one raw error value
// (any decoded JSON) with first-match-wins rules in the reference's order.
func Normalize(errValue any, ctx Context) Result {
	nodeType := ctx.NodeType
	if nodeType == "" {
		nodeType = "node"
	}
	message := readErrorMessage(errValue)
	errObj, _ := errValue.(map[string]any)

	// 1. Secret missing — by error code, then by message shapes.
	secretName := ""
	if errObj != nil && errObj["code"] == "E_SECRET_MISSING" {
		if name, ok := errObj["secret"].(string); ok {
			secretName = name
		}
	}
	if secretName == "" {
		secretName = matchSecretMissing(message)
	}
	if secretName != "" {
		return Result{
			Signature:      "Missing secret: " + ScrubSecretShapes(sanitizeIdentifier(secretName)),
			Category:       "secret_missing",
			SuggestedOwner: "ops",
		}
	}

	// A reaped node's human-readable message contains its startedAt instant.
	// Key the known machine code instead so repeated worker interruptions
	// remain one exact-match recovery cluster and one reusable playbook.
	if errObj != nil && errObj["code"] == "worker_stalled" {
		return Result{
			Signature:      "Worker stalled on " + nodeType + " node",
			Category:       "unknown",
			SuggestedOwner: "platform",
		}
	}

	// 2. HTTP error — explicit statusCode wins; message regex second.
	status := 0
	if errObj != nil {
		if value, ok := errObj["statusCode"].(float64); ok {
			status = int(value)
		}
	}
	if status == 0 {
		if match := httpStatusPattern.FindStringSubmatch(message); match != nil {
			status, _ = strconv.Atoi(match[1])
		}
	}
	if status >= 400 && status < 600 {
		return Result{
			Signature:      "HTTP " + strconv.Itoa(status) + " on " + nodeType + " node",
			Category:       "http_error",
			SuggestedOwner: "workflow_author",
		}
	}

	// 3. Network timeout / connection failures.
	if networkFailurePattern.MatchString(message) {
		return Result{
			Signature:      "Network timeout on " + nodeType + " node",
			Category:       "network_timeout",
			SuggestedOwner: "workflow_author",
		}
	}

	// 3b. Generic rate limit — claims the failure only with NO AI context.
	aiContext := nodeType == "ai" || nodeType == "agent" || nodeType == "multi_agent"
	if errObj != nil {
		if _, ok := errObj["provider"].(string); ok {
			aiContext = true
		}
		if _, ok := errObj["aiError"].(string); ok {
			aiContext = true
		}
	}
	if !aiContext && rateLimitPattern.MatchString(message) {
		return Result{
			Signature:      "Rate limited on " + nodeType + " node",
			Category:       "http_error",
			SuggestedOwner: "workflow_author",
		}
	}

	// 3c. HTTP-layer guard failures (body cap / redirect cap / SSRF block).
	if httpGuardPattern.MatchString(message) {
		return Result{
			Signature:      "HTTP guard failed on " + nodeType + " node",
			Category:       "http_error",
			SuggestedOwner: "workflow_author",
		}
	}

	// 4. AI provider — explicit aiError or message hint.
	if reason := matchAiProviderReason(errObj, message); reason != "" {
		return Result{
			Signature:      inferAiProvider(errObj) + " " + reason,
			Category:       "ai_provider",
			SuggestedOwner: "platform",
		}
	}

	// 5. Parse / JSON error.
	if parseErrorPattern.MatchString(message) {
		return Result{
			Signature:      "Parse error in " + nodeType + " node",
			Category:       "parse_error",
			SuggestedOwner: "workflow_author",
		}
	}

	// 6. Tool-shape errors.
	if kind, tool, matched := matchToolError(message); matched {
		labeled := ctx.ToolName
		if labeled == "" {
			labeled = tool
		}
		cleanTool := "tool"
		if labeled != "" {
			cleanTool = ScrubSecretShapes(sanitizeIdentifier(labeled))
		}
		verb := "Invalid tool input"
		if kind == "not_found" {
			verb = "Tool not found"
		}
		return Result{
			Signature:      verb + ": " + cleanTool,
			Category:       "tool_input",
			SuggestedOwner: "workflow_author",
		}
	}

	// 7. Fallback — scrub + truncate the raw message.
	return Result{
		Signature:      truncate(ScrubSecretShapes(message), fallbackSignatureMaxLength),
		Category:       "unknown",
		SuggestedOwner: "workflow_author",
	}
}

// NormalizeJSON decodes a raw error_json payload and normalizes it.
func NormalizeJSON(raw []byte, ctx Context) Result {
	var value any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &value)
	}
	return Normalize(value, ctx)
}

func matchSecretMissing(message string) string {
	for _, pattern := range []*regexp.Regexp{
		secretNotFoundPattern, envMissingPattern, credentialMissingPattern, missingSecretPattern,
	} {
		if match := pattern.FindStringSubmatch(message); match != nil && match[1] != "" {
			return match[1]
		}
	}
	return ""
}

func matchAiProviderReason(errObj map[string]any, message string) string {
	haystack := message
	if errObj != nil {
		if aiError, ok := errObj["aiError"].(string); ok {
			haystack = aiError + " " + message
		}
	}
	for _, candidate := range aiProviderReasons {
		if candidate.pattern.MatchString(haystack) {
			return candidate.reason
		}
	}
	return ""
}

func inferAiProvider(errObj map[string]any) string {
	if errObj != nil {
		if provider, ok := errObj["provider"].(string); ok {
			switch strings.ToLower(provider) {
			case "openai":
				return "OpenAI"
			case "anthropic":
				return "Anthropic"
			}
		}
	}
	return "AI"
}

func matchToolError(message string) (kind, tool string, matched bool) {
	if match := toolNotFoundPattern.FindStringSubmatch(message); match != nil {
		return "not_found", match[1], true
	}
	if match := toolInvalidPattern.FindStringSubmatch(message); match != nil {
		tool := match[1]
		if tool == "" {
			tool = match[2]
		}
		return "invalid", tool, true
	}
	return "", "", false
}

func readErrorMessage(errValue any) string {
	switch value := errValue.(type) {
	case string:
		return value
	case map[string]any:
		if message, ok := value["message"].(string); ok {
			return message
		}
		if message, ok := value["error"].(string); ok {
			return message
		}
	}
	return "Unknown error"
}

func sanitizeIdentifier(input string) string {
	cleaned := identifierUnsafePattern.ReplaceAllString(input, "")
	if len(cleaned) > 64 {
		return cleaned[:64]
	}
	return cleaned
}

func truncate(input string, maxLength int) string {
	runes := []rune(input)
	if len(runes) <= maxLength {
		return input
	}
	return strings.TrimRight(string(runes[:maxLength-1]), " \t\n") + "…"
}
