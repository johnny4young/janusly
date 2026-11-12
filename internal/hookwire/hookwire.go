// Package hookwire is the contract between `janusly hook` and the ingest
// route: the CloudEvents envelope, its strict per-type fields, its bounds
// and its signature.
package hookwire

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/signedingest"
)

const (
	// Path is the ingest route on the Janusly base URL.
	Path = "/agent-sessions/events"
	// SignatureHeader carries `t=<unix>,v1=<hex hmac>` over "<t>.<body>".
	SignatureHeader = "x-janusly-signature"
	// MaxBodyBytes bounds one event on the wire.
	MaxBodyBytes = 32_000

	maxIDChars   = 200
	maxNameChars = 120
	// maxDurationMs is one week; a longer tool call is a clock error.
	maxDurationMs = 7 * 24 * 60 * 60 * 1000
	// maxAge refuses events older than the retention window.
	maxAge = 14 * 24 * time.Hour
)

// Event types.
const (
	TypeSessionStarted  = "io.janusly.agent.session.started"
	TypePromptSubmitted = "io.janusly.agent.prompt.submitted"
	TypeToolRequested   = "io.janusly.agent.tool.requested"
	TypeToolCompleted   = "io.janusly.agent.tool.completed"
	TypeSubagentStarted = "io.janusly.agent.subagent.started"
	TypeSubagentStopped = "io.janusly.agent.subagent.stopped"
	TypeTurnStopped     = "io.janusly.agent.turn.stopped"
	TypeSessionEnded    = "io.janusly.agent.session.ended"
)

// Runtimes the bridge adapts, keyed by their CloudEvents source.
const (
	RuntimeClaudeCode = "claude-code"
	RuntimeCodex      = "codex"
	sourcePrefix      = "janusly-hook/1/"
)

// Source is the CloudEvents source for a runtime.
func Source(runtime string) string { return sourcePrefix + runtime }

var runtimes = []string{RuntimeClaudeCode, RuntimeCodex}

// Tool kinds.
const (
	ToolBuiltin = "builtin"
	ToolMCP     = "mcp"
	ToolAgent   = "agent"
)

var commonData = []string{"sessionId", "agentId"}

// dataFields is the strict field set per type; anything else rejects the event.
var dataFields = map[string][]string{
	TypeSessionStarted:  {"project", "runtimeVersion", "model"},
	TypePromptSubmitted: {},
	TypeToolRequested:   {"toolUseId", "tool", "toolKind", "mcpServer"},
	TypeToolCompleted:   {"toolUseId", "tool", "toolKind", "mcpServer", "status", "durationMs", "januslyRefs"},
	TypeSubagentStarted: {"parentAgentId", "agentType"},
	TypeSubagentStopped: {"status"},
	TypeTurnStopped:     {},
	TypeSessionEnded:    {"status"},
}

var statuses = map[string][]string{
	TypeToolCompleted:   {"ok", "error", "denied"},
	TypeSubagentStopped: {"ok", "error"},
	TypeSessionEnded:    {"ok", "error", "interrupted"},
}

var envelopeFields = map[string]bool{
	"specversion": true, "id": true, "source": true, "type": true,
	"time": true, "datacontenttype": true, "data": true,
}

// Closing reports the types still accepted once a session is truncated.
func Closing(eventType string) bool {
	return eventType == TypeSessionEnded || eventType == TypeTurnStopped || eventType == TypeSubagentStopped
}

// Refs links a session to what it built in Janusly.
type Refs struct {
	WorkflowID string `json:"workflowId,omitempty"`
	DraftID    string `json:"draftId,omitempty"`
	RunID      string `json:"runId,omitempty"`
}

// Data is the union of every type's fields; Parse enforces which apply.
type Data struct {
	SessionID      string `json:"sessionId"`
	AgentID        string `json:"agentId,omitempty"`
	ParentAgentID  string `json:"parentAgentId,omitempty"`
	AgentType      string `json:"agentType,omitempty"`
	ToolUseID      string `json:"toolUseId,omitempty"`
	Tool           string `json:"tool,omitempty"`
	ToolKind       string `json:"toolKind,omitempty"`
	MCPServer      string `json:"mcpServer,omitempty"`
	Status         string `json:"status,omitempty"`
	DurationMs     *int64 `json:"durationMs,omitempty"`
	Project        string `json:"project,omitempty"`
	RuntimeVersion string `json:"runtimeVersion,omitempty"`
	Model          string `json:"model,omitempty"`
	JanuslyRefs    *Refs  `json:"januslyRefs,omitempty"`
}

// Event is one CloudEvents 1.0 envelope.
type Event struct {
	SpecVersion     string    `json:"specversion"`
	ID              string    `json:"id"`
	Source          string    `json:"source"`
	Type            string    `json:"type"`
	Time            time.Time `json:"time"`
	DataContentType string    `json:"datacontenttype"`
	Data            Data      `json:"data"`
}

// Runtime is the runtime named by the source.
func (e Event) Runtime() string { return strings.TrimPrefix(e.Source, sourcePrefix) }

// EventID is deterministic: a retried hook produces the same id.
func EventID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

// ErrInvalidEvent is the single decode failure; it never echoes input.
var ErrInvalidEvent = errors.New("invalid agent session event")

// ErrSensitiveIdentity refuses identities that look like secrets.
var ErrSensitiveIdentity = errors.New("agent session event identity contains sensitive material")

var (
	eventIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	refPattern     = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
)

// Parse reads one strict event and validates its bounds against now.
func Parse(raw []byte, now time.Time) (Event, error) {
	envelope, ok := signedingest.StrictObject(raw, envelopeFields)
	if !ok {
		return Event{}, ErrInvalidEvent
	}
	var event Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return Event{}, ErrInvalidEvent
	}
	fields, known := dataFields[event.Type]
	if !known {
		return Event{}, ErrInvalidEvent
	}
	allowed := map[string]bool{}
	for _, field := range append(slices.Clone(commonData), fields...) {
		allowed[field] = true
	}
	rawData, ok := envelope["data"]
	if !ok {
		return Event{}, ErrInvalidEvent
	}
	data, ok := signedingest.StrictObject(rawData, allowed)
	if !ok {
		return Event{}, ErrInvalidEvent
	}
	if refs, ok := data["januslyRefs"]; ok {
		if _, ok := signedingest.StrictObject(refs, map[string]bool{"workflowId": true, "draftId": true, "runId": true}); !ok {
			return Event{}, ErrInvalidEvent
		}
	}
	if err := event.validate(now); err != nil {
		return Event{}, err
	}
	return event, nil
}

func (e Event) validate(now time.Time) error {
	d := e.Data
	if e.SpecVersion != "1.0" || !eventIDPattern.MatchString(e.ID) ||
		!slices.Contains(runtimes, e.Runtime()) || !strings.HasPrefix(e.Source, sourcePrefix) ||
		(e.DataContentType != "" && e.DataContentType != "application/json") ||
		e.Time.IsZero() || e.Time.After(now.Add(signedingest.ToleranceSeconds*time.Second)) || e.Time.Before(now.Add(-maxAge)) {
		return ErrInvalidEvent
	}
	if !text(d.SessionID, maxIDChars, true) {
		return ErrInvalidEvent
	}
	for _, id := range []string{d.AgentID, d.ParentAgentID, d.ToolUseID} {
		if !text(id, maxIDChars, false) {
			return ErrInvalidEvent
		}
	}
	for _, name := range []string{d.AgentType, d.MCPServer, d.Model} {
		if !text(name, maxNameChars, false) {
			return ErrInvalidEvent
		}
	}
	// Only the last segment of the working directory ever leaves the machine.
	if !text(d.Project, maxNameChars, false) || strings.ContainsAny(d.Project, `/\`) ||
		!text(d.RuntimeVersion, 40, false) {
		return ErrInvalidEvent
	}
	switch e.Type {
	case TypeToolRequested, TypeToolCompleted:
		if !text(d.Tool, maxIDChars, true) || !slices.Contains([]string{ToolBuiltin, ToolMCP, ToolAgent}, d.ToolKind) ||
			(d.ToolKind != ToolMCP && d.MCPServer != "") {
			return ErrInvalidEvent
		}
	case TypeSubagentStarted, TypeSubagentStopped:
		if d.AgentID == "" {
			return ErrInvalidEvent
		}
	}
	if allowed, ok := statuses[e.Type]; ok && !slices.Contains(allowed, d.Status) {
		return ErrInvalidEvent
	}
	if d.DurationMs != nil && (*d.DurationMs < 0 || *d.DurationMs > maxDurationMs) {
		return ErrInvalidEvent
	}
	if refs := d.JanuslyRefs; refs != nil {
		for _, ref := range []string{refs.WorkflowID, refs.DraftID, refs.RunID} {
			if ref != "" && !refPattern.MatchString(ref) {
				return ErrInvalidEvent
			}
		}
	}
	if d.Project == "." || d.Project == ".." {
		return ErrInvalidEvent
	}
	identity := []string{d.SessionID, d.AgentID, d.ParentAgentID, d.AgentType, d.ToolUseID,
		d.Tool, d.MCPServer, d.Project, d.Model, d.RuntimeVersion}
	if refs := d.JanuslyRefs; refs != nil {
		identity = append(identity, refs.WorkflowID, refs.DraftID, refs.RunID)
	}
	if signedingest.IdentitySensitive(identity...) {
		return ErrSensitiveIdentity
	}
	return nil
}

func text(value string, maxChars int, required bool) bool {
	if value == "" {
		return !required
	}
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= maxChars &&
		strings.TrimSpace(value) == value && !strings.ContainsFunc(value, invisible)
}

// invisible covers control and format characters, such as bidi overrides,
// that could disguise a name on screen.
func invisible(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }

const signingInfo = "janusly/hook-sign/v1"

// SigningKeyFromDigest derives the HMAC key from the stored token digest, so
// the server needs no second secret. The digest alone cannot ingest: the
// bearer still has to be the token itself.
func SigningKeyFromDigest(digest []byte) string {
	key, err := hkdf.Key(sha256.New, digest, nil, signingInfo, 32)
	if err != nil {
		return ""
	}
	return hex.EncodeToString(key)
}

// SigningKeyFromToken is the bridge's side of the same derivation.
func SigningKeyFromToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return SigningKeyFromDigest(sum[:])
}

// Sign returns the signature header for body at unixSeconds.
func Sign(key string, unixSeconds int64, body []byte) string {
	t := strconv.FormatInt(unixSeconds, 10)
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(t + "."))
	_, _ = mac.Write(body)
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// Verify checks a signature header against key within the shared window.
func Verify(header, key string, body []byte, nowUnixSeconds int64) bool {
	return signedingest.VerifyTimestamped(header, string(body), key, nowUnixSeconds)
}

// Gates: a held tool call waiting for a person.
const (
	// GatesPath opens a gate; GatesPath + "/{id}/decision" polls it.
	GatesPath = "/agent-sessions/gates"
	// MaxGateBodyBytes bounds a gate request, captured input included.
	MaxGateBodyBytes = 64_000
	// MaxGateWaitSeconds is one long-poll window.
	MaxGateWaitSeconds = 25

	DecisionPending = "pending"
	DecisionAllow   = "allow"
	DecisionDeny    = "deny"
	// DecisionAsk hands the call back to the runtime's own permission prompt.
	DecisionAsk = "ask"
)

// GateContent is the captured input of a gated call.
type GateContent struct {
	Input any `json:"input"`
}

// GateRequest opens a gate for one tool call.
type GateRequest struct {
	SessionID string       `json:"sessionId"`
	ToolUseID string       `json:"toolUseId"`
	Tool      string       `json:"tool"`
	MCPServer string       `json:"mcpServer,omitempty"`
	AgentID   string       `json:"agentId,omitempty"`
	Content   *GateContent `json:"content,omitempty"`
}

// GateReply is the server's answer to opening or polling a gate.
type GateReply struct {
	GateID   string `json:"gateId,omitempty"`
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

var gateFields = map[string]bool{"sessionId": true, "toolUseId": true, "tool": true, "mcpServer": true, "agentId": true, "content": true}

// ParseGateRequest reads one strict gate request.
func ParseGateRequest(raw []byte) (GateRequest, error) {
	fields, ok := signedingest.StrictObject(raw, gateFields)
	if !ok {
		return GateRequest{}, ErrInvalidEvent
	}
	if content, present := fields["content"]; present {
		if _, ok := signedingest.StrictObject(content, map[string]bool{"input": true}); !ok {
			return GateRequest{}, ErrInvalidEvent
		}
	}
	var request GateRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return GateRequest{}, ErrInvalidEvent
	}
	if !text(request.SessionID, maxIDChars, true) || !text(request.ToolUseID, maxIDChars, true) ||
		!text(request.Tool, maxIDChars, true) || !text(request.MCPServer, maxNameChars, false) ||
		!text(request.AgentID, maxIDChars, false) {
		return GateRequest{}, ErrInvalidEvent
	}
	if signedingest.IdentitySensitive(request.SessionID, request.ToolUseID, request.Tool, request.MCPServer, request.AgentID) {
		return GateRequest{}, ErrSensitiveIdentity
	}
	return request, nil
}
