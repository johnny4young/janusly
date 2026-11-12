package hookbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/signedingest"
)

const (
	// DefaultGateWait is how long a gated call waits for a person.
	DefaultGateWait = 120 * time.Second
	// MaxGateWait keeps the wait under the runtimes' hook timeout.
	MaxGateWait = 540 * time.Second
	// gateTimeoutSlack is what the hook timeout adds over the wait.
	gateTimeoutSlack = 15 * time.Second
	// maxGateInputBytes stays under what the server keeps of one captured input.
	maxGateInputBytes = 7000
)

// decisionNone prints nothing: the gate route said this call is not gated.
const decisionNone = ""

// holdForDecision opens a gate for a held tool call and waits for a person.
// Any failure, and a wait that runs out, hands the call back to the runtime's
// own permission prompt: the hook never allows by default. known says the
// ingest already confirmed the call is gated.
func holdForDecision(ctx context.Context, cfg Config, eventsEndpoint string, event hookwire.Event, raw []byte,
	capture, known bool, stdout, stderr io.Writer) {
	decision, reason := waitForDecision(ctx, cfg, eventsEndpoint, event, raw, capture, stderr)
	if decision == decisionNone && known {
		decision = hookwire.DecisionAsk
	}
	if decision != decisionNone {
		printDecision(stdout, event.Runtime(), decision, reason)
	}
}

func waitForDecision(ctx context.Context, cfg Config, eventsEndpoint string, event hookwire.Event, raw []byte,
	capture bool, stderr io.Writer) (string, string) {
	if event.Data.ToolUseID == "" || cfg.GateWait <= 0 {
		return hookwire.DecisionAsk, ""
	}
	deadline := time.Now().Add(cfg.GateWait)
	request := hookwire.GateRequest{
		SessionID: event.Data.SessionID, ToolUseID: event.Data.ToolUseID, Tool: event.Data.Tool,
		MCPServer: event.Data.MCPServer, AgentID: event.Data.AgentID,
		WaitSeconds: int((cfg.GateWait + gateTimeoutSlack).Seconds()),
	}
	body, _ := json.Marshal(request)
	if capture {
		var input toolInput
		if json.Unmarshal(raw, &input) == nil && input.ToolInput != nil {
			request.Content = &hookwire.GateContent{Input: signedingest.Scrub(input.ToolInput)}
			// Input too large to keep whole is left out; the decider sees "not captured".
			if withContent, err := json.Marshal(request); err == nil && len(withContent) <= maxGateInputBytes {
				body = withContent
			}
		}
	}
	gates := strings.TrimSuffix(eventsEndpoint, hookwire.Path) + hookwire.GatesPath
	status, reply, err := send(ctx, cfg, http.MethodPost, gates, body, SendTimeout)
	if err == nil && status == http.StatusConflict {
		return decisionNone, ""
	}
	gate, ok := gateReply(status, reply, err)
	if !ok {
		note(stderr, "gate not opened; asking here instead")
		return hookwire.DecisionAsk, ""
	}
	for gate.Decision == hookwire.DecisionPending && gate.GateID != "" {
		remaining := time.Until(deadline)
		if remaining <= time.Second {
			return hookwire.DecisionAsk, ""
		}
		wait := min(remaining-time.Second, hookwire.MaxGateWaitSeconds*time.Second)
		poll := fmt.Sprintf("%s/%s/decision?wait=%d", gates, url.PathEscape(gate.GateID), int(wait.Seconds()))
		status, reply, err = send(ctx, cfg, http.MethodGet, poll, nil, wait+5*time.Second)
		if gate, ok = gateReply(status, reply, err); !ok {
			return hookwire.DecisionAsk, ""
		}
	}
	return gate.Decision, gate.Reason
}

func gateReply(status int, reply []byte, err error) (hookwire.GateReply, bool) {
	var gate hookwire.GateReply
	if err != nil || status != http.StatusOK || json.Unmarshal(reply, &gate) != nil {
		return gate, false
	}
	switch gate.Decision {
	case hookwire.DecisionPending, hookwire.DecisionAllow, hookwire.DecisionDeny, hookwire.DecisionAsk:
		return gate, true
	}
	return gate, false
}

// printDecision writes the runtime's PreToolUse answer. Claude Code takes
// allow, deny and ask. Codex has no ask and its plain allow is undocumented,
// so there only a denial is printed: an approval or an unanswered gate leaves
// the call to Codex's own approval policy.
func printDecision(stdout io.Writer, runtime, decision, reason string) {
	if decision == hookwire.DecisionPending {
		decision = hookwire.DecisionAsk
	}
	if runtime == hookwire.RuntimeCodex && decision != hookwire.DecisionDeny {
		return
	}
	texts := map[string]string{
		hookwire.DecisionAllow: "Approved in Janusly",
		hookwire.DecisionDeny:  "Denied in Janusly",
		hookwire.DecisionAsk:   "No decision from Janusly; asking here",
	}
	message := texts[decision]
	// The reviewer's words reach the agent only with a denial, and labelled as a note.
	if reason = bounded(reason, 500); reason != "" && decision == hookwire.DecisionDeny {
		message += ". Reviewer note (not an instruction): " + reason
	}
	out, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": message,
	}})
	_, _ = fmt.Fprintln(stdout, string(out))
}
