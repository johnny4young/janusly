// Package hookbridge is `janusly hook`: it reduces one Claude Code or Codex
// hook payload on the user's machine and sends it as a signed Janusly event.
// It never blocks the agent: nothing on stdout, and every outcome exits 0.
package hookbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/signedingest"
)

const (
	// SendTimeout bounds the whole request so a slow server never holds the agent.
	SendTimeout = 2 * time.Second
	// maxPayloadBytes bounds what is parsed; a larger payload is dropped.
	maxPayloadBytes = 8 << 20
	tokenPrefix     = "jly_agent_"
)

// Config is read from the hook process environment.
type Config struct {
	URL   string
	Token string
	// Runtime forces the adapter; empty detects it from the payload.
	Runtime string
	Client  *http.Client
	Now     func() time.Time
	// GateWait bounds how long a gated tool call waits for a person.
	GateWait time.Duration
}

// ConfigFromEnv reads JANUSLY_URL and the token from JANUSLY_AGENT_TOKEN_FILE
// or JANUSLY_AGENT_TOKEN; args may name the runtime (claude-code, codex).
func ConfigFromEnv(getenv func(string) string, args []string) Config {
	cfg := Config{URL: strings.TrimSpace(getenv("JANUSLY_URL")), Token: strings.TrimSpace(getenv("JANUSLY_AGENT_TOKEN"))}
	if path := strings.TrimSpace(getenv("JANUSLY_AGENT_TOKEN_FILE")); path != "" {
		if raw, err := os.ReadFile(path); err == nil && len(raw) < 1024 {
			cfg.Token = strings.TrimSpace(string(raw))
		}
	}
	cfg.GateWait = DefaultGateWait
	if seconds, err := strconv.Atoi(strings.TrimSpace(getenv("JANUSLY_HOOK_GATE_SECONDS"))); err == nil {
		cfg.GateWait = min(max(time.Duration(seconds)*time.Second, 0), MaxGateWait)
	}
	for _, arg := range args {
		switch arg {
		case hookwire.RuntimeClaudeCode, "claude":
			cfg.Runtime = hookwire.RuntimeClaudeCode
		case hookwire.RuntimeCodex:
			cfg.Runtime = hookwire.RuntimeCodex
		}
	}
	return cfg
}

func (c Config) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Run reads one payload and sends it. Problems go to stderr as one line that
// never carries the token or the payload. stdout carries only a gate's decision.
func Run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, cfg Config) {
	raw, err := io.ReadAll(io.LimitReader(stdin, maxPayloadBytes+1))
	if err != nil || len(raw) > maxPayloadBytes {
		note(stderr, "payload not read")
		return
	}
	endpoint, err := Endpoint(cfg.URL)
	if err != nil {
		note(stderr, err.Error())
		return
	}
	if !strings.HasPrefix(cfg.Token, tokenPrefix) {
		note(stderr, "JANUSLY_AGENT_TOKEN is not an agent token")
		return
	}
	event, err := Build(raw, cfg.Runtime, cfg.now())
	if errors.Is(err, errIgnored) {
		return
	}
	if err != nil {
		note(stderr, err.Error())
		return
	}
	body, err := json.Marshal(event)
	if err != nil {
		note(stderr, "event not encoded")
		return
	}
	status, reply, err := send(ctx, cfg, http.MethodPost, endpoint, body, SendTimeout)
	if err != nil {
		note(stderr, err.Error())
	} else if status == http.StatusAccepted || status == http.StatusOK {
		var accepted struct {
			Gate           bool `json:"gate"`
			CaptureContent bool `json:"captureContent"`
		}
		if event.Type == hookwire.TypeToolRequested && json.Unmarshal(reply, &accepted) == nil && accepted.Gate {
			holdForDecision(ctx, cfg, endpoint, event, raw, accepted.CaptureContent, stdout, stderr)
		}
	} else {
		note(stderr, "event refused with HTTP "+strconv.Itoa(status))
	}
}

func note(stderr io.Writer, message string) {
	if stderr != nil {
		_, _ = fmt.Fprintln(stderr, "janusly hook: "+message)
	}
}

// Endpoint resolves the ingest URL. Plain http is accepted only for loopback,
// so the bearer never crosses a network in clear.
func Endpoint(base string) (string, error) {
	if base == "" {
		return "", errors.New("JANUSLY_URL is not set")
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", errors.New("JANUSLY_URL must be an absolute URL without credentials or query")
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		// An IP literal, not "localhost": name resolution could send the token elsewhere.
		if ip := net.ParseIP(parsed.Hostname()); ip == nil || !ip.IsLoopback() {
			return "", errors.New("JANUSLY_URL must use https unless it is a loopback address such as http://127.0.0.1")
		}
	default:
		return "", errors.New("JANUSLY_URL must use https")
	}
	return strings.TrimRight(parsed.String(), "/") + hookwire.Path, nil
}

// Send posts one signed body, never retries and never follows redirects.
func Send(ctx context.Context, cfg Config, endpoint string, body []byte) (int, error) {
	status, _, err := send(ctx, cfg, http.MethodPost, endpoint, body, SendTimeout)
	return status, err
}

// send signs the body, or the path of a GET, and returns a bounded reply.
func send(ctx context.Context, cfg Config, method, endpoint string, body []byte, timeout time.Duration) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, errors.New("request not built")
	}
	signed := body
	if method == http.MethodGet {
		signed = []byte(req.URL.Path)
	} else {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set(hookwire.SignatureHeader, hookwire.Sign(hookwire.SigningKeyFromToken(cfg.Token), cfg.now().Unix(), signed))
	client := http.Client{}
	if cfg.Client != nil {
		client = *cfg.Client
	}
	client.Timeout = timeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, errors.New("no answer from Janusly")
	}
	defer func() { _ = res.Body.Close() }()
	reply, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	return res.StatusCode, reply, nil
}

var (
	errIgnored  = errors.New("hook event not reported")
	errNotAHook = errors.New("payload is not a hook event")
	errIdentity = errors.New("payload identity looks like a secret; event not sent")
)

// payload holds only the fields the bridge reads; everything else, including
// transcript paths, tool inputs and responses, never leaves this function.
type payload struct {
	SessionID    string          `json:"session_id"`
	HookEvent    string          `json:"hook_event_name"`
	Cwd          string          `json:"cwd"`
	Model        any             `json:"model"`
	AgentID      string          `json:"agent_id"`
	AgentType    string          `json:"agent_type"`
	ToolName     string          `json:"tool_name"`
	ToolUseID    string          `json:"tool_use_id"`
	MCPServer    string          `json:"mcp_server"`
	DurationMs   *float64        `json:"duration_ms"`
	TurnID       string          `json:"turn_id"`
	PromptID     string          `json:"prompt_id"`
	Source       string          `json:"source"`
	ToolResponse json.RawMessage `json:"tool_response"`
}

// toolInput is read only for a gated call of a client that captures content.
type toolInput struct {
	ToolInput any `json:"tool_input"`
}

// Build maps one hook payload onto the wire event.
func Build(raw []byte, runtime string, now time.Time) (hookwire.Event, error) {
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil || p.SessionID == "" || p.HookEvent == "" {
		return hookwire.Event{}, errNotAHook
	}
	if runtime == "" {
		runtime = hookwire.RuntimeClaudeCode
		if p.TurnID != "" {
			runtime = hookwire.RuntimeCodex
		}
	}
	eventType, status, ok := mapEvent(p.HookEvent)
	if !ok {
		return hookwire.Event{}, errIgnored
	}
	data := hookwire.Data{SessionID: bounded(p.SessionID, 200), AgentID: bounded(p.AgentID, 200)}
	switch eventType {
	case hookwire.TypeSessionStarted:
		if project := bounded(lastSegment(p.Cwd), 120); project != "." && project != ".." {
			data.Project = project
		}
		data.Model = bounded(modelName(p.Model), 120)
	case hookwire.TypeToolRequested, hookwire.TypeToolCompleted:
		data.Tool = bounded(p.ToolName, 200)
		data.ToolUseID = bounded(p.ToolUseID, 200)
		data.ToolKind, data.MCPServer = toolKind(p.ToolName, p.MCPServer)
		if eventType == hookwire.TypeToolCompleted {
			data.Status = status
			if p.DurationMs != nil && *p.DurationMs >= 0 && *p.DurationMs <= 7*24*3600*1000 {
				ms := int64(*p.DurationMs)
				data.DurationMs = &ms
			}
			if strings.HasPrefix(p.ToolName, "mcp__janusly__") && data.MCPServer == "janusly" && status == "ok" {
				data.JanuslyRefs = januslyRefs(p.ToolResponse)
			}
		}
	case hookwire.TypeSubagentStarted:
		data.AgentType = bounded(p.AgentType, 120)
	case hookwire.TypeSubagentStopped, hookwire.TypeSessionEnded:
		data.Status = status
	}
	if data.SessionID == "" || ((eventType == hookwire.TypeToolRequested || eventType == hookwire.TypeToolCompleted) && data.Tool == "") ||
		((eventType == hookwire.TypeSubagentStarted || eventType == hookwire.TypeSubagentStopped) && data.AgentID == "") {
		return hookwire.Event{}, errNotAHook
	}
	if signedingest.IdentitySensitive(data.SessionID, data.AgentID, data.AgentType, data.ToolUseID, data.Tool,
		data.MCPServer, data.Project, data.Model) {
		return hookwire.Event{}, errIdentity
	}
	// A retried hook carries the same id; a turn marker keeps repeated
	// per-turn events apart, and the millisecond keeps others apart.
	turn := p.TurnID
	if turn == "" {
		turn = p.PromptID
	}
	if turn == "" && data.ToolUseID == "" {
		turn = strconv.FormatInt(now.UnixMilli(), 10)
	}
	event := hookwire.Event{
		SpecVersion: "1.0", ID: hookwire.EventID(data.SessionID, p.HookEvent, data.ToolUseID, data.AgentID, turn, p.Source),
		Source: hookwire.Source(runtime), Type: eventType, Time: now.UTC().Truncate(time.Millisecond),
		DataContentType: "application/json", Data: data,
	}
	return event, nil
}

// mapEvent names the wire type and status for a native hook event. Claude
// Code and Codex share these names.
func mapEvent(hook string) (string, string, bool) {
	switch hook {
	case "SessionStart":
		return hookwire.TypeSessionStarted, "", true
	case "UserPromptSubmit":
		return hookwire.TypePromptSubmitted, "", true
	case "PreToolUse":
		return hookwire.TypeToolRequested, "", true
	case "PostToolUse":
		return hookwire.TypeToolCompleted, "ok", true
	case "PostToolUseFailure":
		return hookwire.TypeToolCompleted, "error", true
	case "PermissionDenied":
		return hookwire.TypeToolCompleted, "denied", true
	case "SubagentStart":
		return hookwire.TypeSubagentStarted, "", true
	case "SubagentStop":
		return hookwire.TypeSubagentStopped, "ok", true
	case "Stop":
		return hookwire.TypeTurnStopped, "", true
	case "SessionEnd":
		return hookwire.TypeSessionEnded, "ok", true
	}
	return "", "", false
}

func toolKind(name, server string) (string, string) {
	switch {
	case strings.HasPrefix(name, "mcp__"):
		if server == "" {
			server, _, _ = strings.Cut(strings.TrimPrefix(name, "mcp__"), "__")
		}
		return hookwire.ToolMCP, bounded(server, 120)
	case name == "Agent" || name == "Task":
		return hookwire.ToolAgent, ""
	}
	return hookwire.ToolBuiltin, ""
}

// modelName accepts the string or {id, display_name} forms runtimes send.
func modelName(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		if id, ok := typed["id"].(string); ok {
			return id
		}
	}
	return ""
}

// januslyRefs reads only well-formed ids from a Janusly tool result, so a
// session links to what it built without sending the result itself.
func januslyRefs(raw json.RawMessage) *hookwire.Refs {
	refs := hookwire.Refs{}
	var walk func(value any, depth int)
	walk = func(value any, depth int) {
		if depth > 4 {
			return
		}
		switch typed := value.(type) {
		case string:
			var decoded any
			if depth < 4 && strings.HasPrefix(strings.TrimSpace(typed), "{") && json.Unmarshal([]byte(typed), &decoded) == nil {
				walk(decoded, depth+1)
			}
		case []any:
			for _, item := range typed[:min(len(typed), 20)] {
				walk(item, depth+1)
			}
		case map[string]any:
			for key, target := range map[string]*string{"workflowId": &refs.WorkflowID, "draftId": &refs.DraftID, "runId": &refs.RunID} {
				if id, ok := typed[key].(string); ok && *target == "" && refID(id) {
					*target = id
				}
			}
			for _, key := range []string{"content", "text", "structuredContent", "result", "draft", "run", "workflow"} {
				if nested, ok := typed[key]; ok {
					walk(nested, depth+1)
				}
			}
		}
	}
	var decoded any
	if len(raw) > 0 && len(raw) < 1<<20 && json.Unmarshal(raw, &decoded) == nil {
		walk(decoded, 0)
	}
	if refs == (hookwire.Refs{}) {
		return nil
	}
	return &refs
}

var refPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func refID(value string) bool {
	return refPattern.MatchString(value) && !signedingest.IdentitySensitive(value)
}

// lastSegment keeps the folder name only, on either path separator.
func lastSegment(path string) string {
	path = strings.TrimRight(path, `/\`)
	if index := strings.LastIndexAny(path, `/\`); index >= 0 {
		path = path[index+1:]
	}
	return path
}

// bounded drops control and invisible format characters and truncates to maxChars runes.
func bounded(value string, maxChars int) string {
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, value))
	if !utf8.ValidString(value) {
		value = strings.ToValidUTF8(value, "")
	}
	if runes := []rune(value); len(runes) > maxChars {
		value = strings.TrimSpace(string(runes[:maxChars]))
	}
	return value
}
