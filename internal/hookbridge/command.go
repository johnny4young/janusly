package hookbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/johnny4young/janusly/internal/hookwire"
)

// hookEvents are the native events the bridge reports, per runtime.
var hookEvents = map[string][]string{
	hookwire.RuntimeClaudeCode: {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
		"PermissionDenied", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"},
	hookwire.RuntimeCodex: {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
		"SubagentStart", "SubagentStop", "Stop", "SessionEnd"},
}

// Main serves `janusly hook [claude-code|codex]`, `janusly hook doctor` and
// `janusly hook config <runtime>`. Only doctor and config exit non-zero.
func Main(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, getenv func(string) string) int {
	if len(args) > 0 {
		switch args[0] {
		case "doctor":
			return Doctor(ctx, stdout, ConfigFromEnv(getenv, args[1:]))
		case "config":
			return printConfig(stdout, stderr, args[1:])
		}
	}
	// A terminal is not a hook runner: never wait on someone typing.
	if file, ok := stdin.(*os.File); ok {
		if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			note(stderr, "reads one hook payload on stdin; see janusly hook doctor and janusly hook config")
			return 0
		}
	}
	Run(ctx, stdin, stdout, stderr, ConfigFromEnv(getenv, args))
	return 0
}

// Doctor checks the environment and sends a signed, deliberately empty event:
// the server answers 400 only after the token, capability and signature pass,
// so nothing is stored.
func Doctor(ctx context.Context, stdout io.Writer, cfg Config) int {
	say := func(ok bool, format string, args ...any) {
		mark := "ok  "
		if !ok {
			mark = "fail"
		}
		_, _ = fmt.Fprintf(stdout, "%s %s\n", mark, fmt.Sprintf(format, args...))
	}
	endpoint, err := Endpoint(cfg.URL)
	if err != nil {
		say(false, "%s", err)
		return 1
	}
	say(true, "endpoint %s", endpoint)
	if !strings.HasPrefix(cfg.Token, tokenPrefix) {
		say(false, "JANUSLY_AGENT_TOKEN is not an agent token")
		return 1
	}
	say(true, "agent token present")
	status, err := Send(ctx, cfg, endpoint, []byte(`{}`))
	switch {
	case err != nil:
		say(false, "%s", err)
	case status == http.StatusBadRequest:
		say(true, "token, report capability and signature accepted")
		return 0
	case status == http.StatusUnauthorized:
		say(false, "token or signature refused (HTTP 401): revoked, expired, or clocks more than 5 minutes apart")
	case status == http.StatusForbidden:
		say(false, "the agent client lacks the report capability, or the host is not allowed (HTTP 403)")
	case status == http.StatusNotFound:
		say(false, "no ingest route (HTTP 404): remote MCP is not enabled on this Janusly")
	default:
		say(false, "unexpected HTTP %d", status)
	}
	return 1
}

func printConfig(stdout, stderr io.Writer, args []string) int {
	runtime := ""
	if len(args) > 0 {
		runtime = ConfigFromEnv(func(string) string { return "" }, args[:1]).Runtime
	}
	events, ok := hookEvents[runtime]
	if !ok {
		_, _ = fmt.Fprintln(stderr, "usage: janusly hook config claude-code|codex")
		return 2
	}
	hooks := map[string]any{}
	for _, event := range events {
		// The bridge gives up after two seconds; SessionEnd runs with a short
		// budget, and PreToolUse may hold a gated call for a person.
		timeout := 5
		switch event {
		case "SessionEnd":
			timeout = 3
		case "PreToolUse":
			timeout = int((DefaultGateWait + gateTimeoutSlack).Seconds())
		}
		hooks[event] = []any{map[string]any{"hooks": []any{map[string]any{
			"type": "command", "command": "janusly hook " + runtime, "timeout": timeout,
		}}}}
	}
	encoded, _ := json.MarshalIndent(map[string]any{"hooks": hooks}, "", "  ")
	_, _ = fmt.Fprintln(stdout, string(encoded))
	return 0
}
