// The MCP client chokepoint for `mcp_tool` workflow nodes, ported from
// the reference's mcp-tool-executor: one Execute that takes
// {connectionAlias, toolName, input} and produces the typed envelope the
// node executor consumes. The defense ladder runs in the reference's
// order — org scope, connection enabled/active, descriptor found/enabled,
// input-schema validation, dry-run write-skip, two-flag write consent,
// env-ref resolution (generic error, CRLF reject), per-tool rate limit
// (fail-open) — before any transport is built. Execute NEVER panics or
// throws: every failure becomes {ok:false, error}.
//
// Transports:
//   - stdio spawns a child with a strict env whitelist ({PATH} + resolved
//     env refs), a fresh temp working dir, a command allowlist, a lifetime
//     watchdog, and a redacted capped stderr capture — the reference's
//     sandbox defenses.
//   - sse / http validate the URL under the pilot's SSRF policy BEFORE
//     construction and hand the SDK an *http.Client whose dialer connects
//     ONLY to the pinned validated address, so DNS rebinding cannot
//     redirect a fetch or redirect to a private target. Resolved env refs
//     flow as request headers (key = header name).
//
// The create+discovery+audit triplet is deliberately NOT wrapped in a
// transaction — network I/O must never run under a Postgres tx.
package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	defaultTimeoutMs = 30_000
	maxTimeoutMs     = 120_000

	// Sandbox failure codes — stable, ported verbatim.
	CodeCommandRejected  = "mcp_sandbox_command_rejected"
	CodeLifetimeExceeded = "mcp_sandbox_lifetime_exceeded"
	CodeStderrExceeded   = "mcp_sandbox_stderr_exceeded"

	defaultStdioLifetimeMs  = 120_000
	defaultStdioStderrBytes = 65_536
	defaultClientRatePerMin = 60
	stderrTailChars         = 1024
	rateLimitWindow         = time.Minute
	clientWritesEnabledEnv  = "JANUSLY_MCP_CLIENT_WRITES_ENABLED"
	stdioAllowedCommandsEnv = "JANUSLY_MCP_STDIO_ALLOWED_COMMANDS"
)

// Client executes MCP tool calls for workflow runs.
type Client struct {
	pool    *pgxpool.Pool
	limiter *ratelimit.Limiter
	// httpOpts injects the SSRF seams (tests override Resolve).
	httpOpts executors.HTTPOptions
	// lifetimeOverride shortens the stdio watchdog (tests only — the
	// catalog floor for mcp.stdioMaxLifetimeMs is one minute).
	lifetimeOverride time.Duration
}

// New builds the client. limiter may be nil (tests).
func New(pool *pgxpool.Pool, limiter *ratelimit.Limiter) *Client {
	return &Client{pool: pool, limiter: limiter}
}

// SetHTTPOptions overrides the SSRF seams (tests only).
func (c *Client) SetHTTPOptions(opts executors.HTTPOptions) { c.httpOpts = opts }

// SetStdioLifetime overrides the watchdog duration (tests only).
func (c *Client) SetStdioLifetime(d time.Duration) { c.lifetimeOverride = d }

// Call mirrors executors.McpCall plus the run-scope metadata the
// dispatcher resolves per claim.
type Call struct {
	OrgID           string
	ConnectionAlias string
	ToolName        string
	Input           map[string]any
	TimeoutMs       float64
	DryRun          bool
	RunID           string
	NodeID          string
	WorkflowID      string
}

// Execute runs the full defense ladder + transport call. Never panics.
func (c *Client) Execute(ctx context.Context, call Call) (envelope executors.McpEnvelope) {
	start := time.Now()
	envelope = executors.McpEnvelope{
		ConnectionAlias: call.ConnectionAlias, ToolName: call.ToolName,
		Transport: "stdio", WriteSide: true,
	}
	defer func() {
		if r := recover(); r != nil {
			envelope.OK = false
			envelope.Error = "mcp tool call failed"
			envelope.LatencyMs = time.Since(start).Milliseconds()
		}
		c.fireUsage(ctx, call, envelope)
	}()
	fail := func(message string) executors.McpEnvelope {
		envelope.OK = false
		envelope.Error = message
		envelope.LatencyMs = time.Since(start).Milliseconds()
		return envelope
	}

	if call.OrgID == "" {
		return fail("mcp_tool requires multi-tenant context")
	}
	q := store.New(c.pool)
	connection, err := q.GetMcpConnectionByAlias(ctx, store.GetMcpConnectionByAliasParams{
		OrgID: call.OrgID, Alias: call.ConnectionAlias,
	})
	if err != nil {
		return fail(fmt.Sprintf("mcp connection not found: %s", call.ConnectionAlias))
	}
	envelope.Transport = connection.Transport
	if !connection.Enabled || connection.Status == "disabled" {
		return fail("mcp connection disabled")
	}
	if connection.Status != "active" {
		return fail(fmt.Sprintf("mcp connection not active (status=%s)", connection.Status))
	}
	descriptor, err := q.GetMcpToolDescriptor(ctx, store.GetMcpToolDescriptorParams{
		ConnectionID: connection.ID, Name: call.ToolName,
	})
	if err != nil {
		return fail(fmt.Sprintf("mcp tool not found: %s", call.ToolName))
	}
	envelope.WriteSide = descriptor.WriteSide
	if !descriptor.Enabled {
		return fail("mcp tool not enabled for this org")
	}

	input := call.Input
	if input == nil {
		input = map[string]any{}
	}
	var schema map[string]any
	if len(descriptor.InputSchema) > 0 {
		_ = json.Unmarshal(descriptor.InputSchema, &schema)
	}
	if validationError := validateToolInput(schema, input); validationError != "" {
		return fail(validationError)
	}

	// Dry-run gate: write-side MCP tools skip during validation runs;
	// read-side tools still execute so validation produces real signal.
	if call.DryRun && descriptor.WriteSide {
		envelope.OK = true
		envelope.Output = map[string]any{"dryRun": true, "skipped": true}
		envelope.LatencyMs = time.Since(start).Milliseconds()
		return envelope
	}

	// Two-flag write consent (process + tenant). Either false → reject.
	if descriptor.WriteSide {
		if os.Getenv(clientWritesEnabledEnv) != "true" {
			return fail("mcp_client_writes_disabled (process)")
		}
		if !orgconfig.LoadBool(ctx, c.pool, call.OrgID, "mcp.clientWriteConsent") {
			return fail("mcp_client_writes_disabled (tenant)")
		}
	}

	// Env-ref resolution: generic error on miss — NEVER echo the env-var
	// name; CRLF values rejected so they can't smuggle a header line into
	// the URL transports' outbound requests.
	resolvedEnv := map[string]string{}
	var envRefs map[string]struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if len(connection.EnvRefs) > 0 {
		_ = json.Unmarshal(connection.EnvRefs, &envRefs)
	}
	for key, ref := range envRefs {
		if ref.Kind != "env" {
			continue
		}
		value, refErr := lookupEnvRef(ref.Name)
		if refErr != "" {
			return fail(fmt.Sprintf("%s for %s", refErr, key))
		}
		resolvedEnv[key] = value
	}

	// Per-tool rate limit: descriptor override wins over the org default;
	// bucket per (alias, toolName); fail-open (limiter handles that).
	effectiveLimit := defaultClientRatePerMin
	if configured := int(orgconfig.LoadNumber(ctx, c.pool, call.OrgID, "mcp.clientRateLimitPerMin")); configured > 0 {
		effectiveLimit = configured
	}
	if descriptor.RateLimitPerMin.Valid {
		effectiveLimit = int(descriptor.RateLimitPerMin.Int32)
	}
	if c.limiter != nil {
		if err := c.limiter.Enforce(ctx, call.OrgID, ratelimit.Options{
			Name: fmt.Sprintf("mcp_client.%s.%s", connection.Alias, call.ToolName),
			Max:  effectiveLimit, Window: rateLimitWindow,
		}); err != nil {
			return fail(err.Error())
		}
	}

	timeout := clampTimeout(call.TimeoutMs)
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	result, sandbox, callErr := c.callTransport(callCtx, connection, resolvedEnv, call.ToolName, input)
	if sandbox != nil && sandbox.stopWatchdog != nil {
		sandbox.stopWatchdog()
	}
	envelope.LatencyMs = time.Since(start).Milliseconds()
	if sandbox != nil {
		envelope.StderrTail = sandbox.tail()
		if code := sandbox.failureCode(); code != "" {
			envelope.SandboxFailureCode = code
			envelope.OK = false
			envelope.Error = code
			return envelope
		}
	}
	if callErr != nil {
		message := callErr.Error()
		if callCtx.Err() == context.DeadlineExceeded {
			message = "timeout"
		}
		envelope.OK = false
		envelope.Error = truncate(signature.ScrubSecretShapes(message), 200)
		return envelope
	}
	if result.IsError {
		text := "mcp tool returned isError=true"
		if extracted := textOfContent(result); extracted != "" {
			text = extracted
		}
		envelope.OK = false
		envelope.Error = truncate(signature.ScrubSecretShapes(text), 200)
		return envelope
	}
	envelope.OK = true
	envelope.Output = normalizeOutput(result)
	return envelope
}

// dialSession builds the transport-specific session. Adding a transport
// = a new branch here; everything above stays transport-agnostic. The
// caller owns session.Close and (for stdio) sandbox.stopWatchdog.
func (c *Client) dialSession(
	ctx context.Context, connection store.McpConnection, resolvedEnv map[string]string,
) (*mcp.ClientSession, *stdioSandbox, error) {
	var transport mcp.Transport
	var sandbox *stdioSandbox
	switch connection.Transport {
	case "stdio":
		command := connection.Command.String
		var args []string
		if len(connection.Args) > 0 {
			_ = json.Unmarshal(connection.Args, &args)
		}
		built, err := c.newStdioSandbox(ctx, connection.OrgID, command, args, resolvedEnv)
		if err != nil {
			return nil, built, err
		}
		sandbox = built
		transport = &mcp.CommandTransport{Command: sandbox.cmd}
	case "sse", "http":
		rawURL := connection.Url.String
		// SSRF validation BEFORE construction; the pinned client keeps the
		// validated IP for every SDK fetch/redirect.
		httpClient, err := executors.NewPinnedHTTPClient(ctx, rawURL, c.httpOpts)
		if err != nil {
			return nil, nil, err
		}
		httpClient.Transport = &headerInjector{next: httpClient.Transport, headers: resolvedEnv}
		if connection.Transport == "sse" {
			transport = &mcp.SSEClientTransport{Endpoint: rawURL, HTTPClient: httpClient}
		} else {
			transport = &mcp.StreamableClientTransport{Endpoint: rawURL, HTTPClient: httpClient}
		}
	default:
		return nil, nil, fmt.Errorf("unsupported mcp transport: %s", connection.Transport)
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "janusly-pilot", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, sandbox, err
	}
	return session, sandbox, nil
}

// callTransport dials and invokes the tool.
func (c *Client) callTransport(
	ctx context.Context, connection store.McpConnection, resolvedEnv map[string]string,
	toolName string, input map[string]any,
) (*mcp.CallToolResult, *stdioSandbox, error) {
	session, sandbox, err := c.dialSession(ctx, connection, resolvedEnv)
	if err != nil {
		return nil, sandbox, err
	}
	defer func() { _ = session.Close() }()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: toolName, Arguments: input})
	if err != nil {
		return nil, sandbox, err
	}
	return result, sandbox, nil
}

// lookupEnvRef resolves one env-ref value with the generic error posture:
// the env-var NAME never reaches an error message.
func lookupEnvRef(name string) (string, string) {
	value := os.Getenv(name)
	if value == "" {
		return "", "credential secret missing"
	}
	if strings.ContainsAny(value, "\r\n") {
		return "", "credential value invalid"
	}
	return value, ""
}

// headerInjector adds the resolved env-ref values as request headers on
// every outbound SDK request (key = header name), mirroring the
// reference's URL-transport credential flow.
type headerInjector struct {
	next    http.RoundTripper
	headers map[string]string
}

func (h *headerInjector) RoundTrip(req *http.Request) (*http.Response, error) {
	for key, value := range h.headers {
		req.Header.Set(key, value)
	}
	next := h.next
	if next == nil {
		next = http.DefaultTransport
	}
	return next.RoundTrip(req)
}

// stdioSandbox owns the child process defenses: command allowlist, env
// whitelist, fresh temp cwd, lifetime watchdog, capped redacted stderr.
type stdioSandbox struct {
	cmd     *exec.Cmd
	tempDir string
	// kill cancels the exec.CommandContext — os/exec owns the actual
	// process kill, so no goroutine here ever touches cmd.Process (that
	// read would race the SDK's Start).
	kill context.CancelFunc

	mu             sync.Mutex
	stderr         []byte
	stderrExceeded bool
	lifetimeKilled bool
	rejected       string
	stopWatchdog   func()
}

func (c *Client) newStdioSandbox(
	ctx context.Context, orgID, command string, args []string,
	resolvedEnv map[string]string,
) (*stdioSandbox, error) {
	pool := c.pool
	sandbox := &stdioSandbox{}
	if command == "" {
		return sandbox, fmt.Errorf("mcp stdio connection has no command")
	}
	allowed := stdioAllowedCommands(ctx, pool, orgID)
	if !allowed[command] {
		sandbox.rejected = "command not in the stdio allowlist"
		return sandbox, fmt.Errorf("%s: %s", CodeCommandRejected, sandbox.rejected)
	}

	tempDir, err := os.MkdirTemp("", "janusly-mcp-")
	if err != nil {
		return sandbox, err
	}
	sandbox.tempDir = tempDir

	killCtx, kill := context.WithCancel(context.Background())
	sandbox.kill = kill
	cmd := exec.CommandContext(killCtx, command, args...)
	cmd.Dir = tempDir
	// Strict env whitelist: {PATH} + resolved refs. The child NEVER sees
	// the worker's process env (DATABASE_URL etc.).
	env := []string{"PATH=" + os.Getenv("PATH")}
	for key, value := range resolvedEnv {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	cmd.Stderr = &cappedStderr{sandbox: sandbox, cap: stdioStderrCap(ctx, pool, orgID)}
	sandbox.cmd = cmd

	// Lifetime watchdog: kills the child after the cap regardless of what
	// it is doing. Armed now; the SDK's Close still owns graceful exits.
	lifetime := stdioLifetime(ctx, pool, orgID)
	if c.lifetimeOverride > 0 {
		lifetime = c.lifetimeOverride
	}
	timer := time.AfterFunc(lifetime, func() {
		sandbox.mu.Lock()
		sandbox.lifetimeKilled = true
		sandbox.mu.Unlock()
		kill()
	})
	sandbox.stopWatchdog = func() {
		timer.Stop()
		kill()
		_ = os.RemoveAll(tempDir)
	}
	return sandbox, nil
}

// tail returns the last redacted chars of the captured stderr.
func (s *stdioSandbox) tail() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	captured := string(s.stderr)
	s.mu.Unlock()
	redacted := aiguidance.ScrubGuidanceSecrets(signature.ScrubSecretShapes(captured))
	runes := []rune(redacted)
	if len(runes) > stderrTailChars {
		runes = runes[len(runes)-stderrTailChars:]
	}
	return string(runes)
}

func (s *stdioSandbox) failureCode() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.rejected != "":
		return CodeCommandRejected
	case s.stderrExceeded:
		return CodeStderrExceeded
	case s.lifetimeKilled:
		return CodeLifetimeExceeded
	}
	return ""
}

// cappedStderr accumulates stderr up to the cap, then kills the child —
// a misbehaving server cannot flood the worker's memory.
type cappedStderr struct {
	sandbox *stdioSandbox
	cap     int
}

func (w *cappedStderr) Write(p []byte) (int, error) {
	s := w.sandbox
	s.mu.Lock()
	remaining := w.cap - len(s.stderr)
	if remaining > 0 {
		if len(p) < remaining {
			s.stderr = append(s.stderr, p...)
		} else {
			s.stderr = append(s.stderr, p[:remaining]...)
		}
	}
	exceeded := len(s.stderr) >= w.cap && len(p) > remaining
	if exceeded {
		s.stderrExceeded = true
	}
	s.mu.Unlock()
	if exceeded && s.kill != nil {
		s.kill()
	}
	return len(p), nil
}

// stdioAllowedCommands reads the catalog's mcp.clientCommandAllowlist
// (tenant row, JANUSLY_MCP_ALLOWED_COMMANDS env fallback). Empty allowlist
// = fail-closed: no stdio command may spawn.
func stdioAllowedCommands(ctx context.Context, pool *pgxpool.Pool, orgID string) map[string]bool {
	allowed := map[string]bool{}
	tenant, _ := orgconfig.LoadValue(ctx, pool, orgID, "mcp.clientCommandAllowlist").(string)
	for entry := range strings.SplitSeq(tenant, ",") {
		if trimmed := strings.TrimSpace(entry); trimmed != "" {
			allowed[trimmed] = true
		}
	}
	return allowed
}

func stdioLifetime(ctx context.Context, pool *pgxpool.Pool, orgID string) time.Duration {
	if configured := orgconfig.LoadNumber(ctx, pool, orgID, "mcp.stdioMaxLifetimeMs"); configured > 0 {
		return time.Duration(configured) * time.Millisecond
	}
	return defaultStdioLifetimeMs * time.Millisecond
}

func stdioStderrCap(ctx context.Context, pool *pgxpool.Pool, orgID string) int {
	if configured := int(orgconfig.LoadNumber(ctx, pool, orgID, "mcp.stdioMaxStderrBytes")); configured > 0 {
		return configured
	}
	return defaultStdioStderrBytes
}

func clampTimeout(value float64) time.Duration {
	if value < 1000 {
		return defaultTimeoutMs * time.Millisecond
	}
	if value > maxTimeoutMs {
		return maxTimeoutMs * time.Millisecond
	}
	return time.Duration(value) * time.Millisecond
}

func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

// normalizeOutput collapses the SDK result into the single output object
// workflow nodes read: text (first text content), structuredContent, raw.
func normalizeOutput(result *mcp.CallToolResult) map[string]any {
	output := map[string]any{"isError": result.IsError}
	if text := textOfContent(result); text != "" {
		output["text"] = text
	}
	if result.StructuredContent != nil {
		output["structuredContent"] = result.StructuredContent
	}
	raw, err := json.Marshal(result)
	if err == nil {
		var rawMap map[string]any
		if json.Unmarshal(raw, &rawMap) == nil {
			output["raw"] = rawMap
		}
	}
	return output
}

func textOfContent(result *mcp.CallToolResult) string {
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			return text.Text
		}
	}
	return ""
}

// validateToolInput ports the reference's JSON-Schema-subset validation:
// object-type check, required fields, per-property primitive types, and
// additionalProperties:false unknown-field rejection.
func validateToolInput(schema map[string]any, value map[string]any) string {
	if schema == nil {
		return ""
	}
	if schemaType, ok := schema["type"].(string); ok && schemaType != "object" {
		return "mcp tool input schema must be an object schema"
	}
	properties, _ := schema["properties"].(map[string]any)
	required, _ := schema["required"].([]any)
	for _, entry := range required {
		key, _ := entry.(string)
		if key == "" {
			continue
		}
		if _, present := value[key]; !present {
			return fmt.Sprintf("mcp tool input missing required field: %s", key)
		}
	}
	for key, rawPropSchema := range properties {
		propValue, present := value[key]
		if !present || propValue == nil {
			continue
		}
		propSchema, _ := rawPropSchema.(map[string]any)
		if propSchema == nil {
			continue
		}
		expected, _ := propSchema["type"].(string)
		if expected != "" && !valueMatchesType(propValue, expected) {
			return fmt.Sprintf("mcp tool input field %s must be %s", key, expected)
		}
	}
	if additional, ok := schema["additionalProperties"].(bool); ok && !additional {
		for key := range value {
			if _, known := properties[key]; !known {
				return fmt.Sprintf("mcp tool input contains unknown field: %s", key)
			}
		}
	}
	return ""
}

func valueMatchesType(value any, expected string) bool {
	switch expected {
	case "string":
		_, ok := value.(string)
		return ok
	case "number", "integer":
		_, ok := value.(float64)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	}
	return true
}

// fireUsage writes the per-call usage row — best-effort, telemetry never
// breaks the call.
func (c *Client) fireUsage(ctx context.Context, call Call, envelope executors.McpEnvelope) {
	metadata := map[string]any{
		"connectionAlias": envelope.ConnectionAlias, "toolName": envelope.ToolName,
		"transport": envelope.Transport, "ok": envelope.OK,
		"writeSide": envelope.WriteSide, "latencyMs": envelope.LatencyMs,
	}
	if envelope.Error != "" {
		metadata["error"] = envelope.Error
	}
	if call.WorkflowID != "" {
		metadata["workflowId"] = call.WorkflowID
	}
	if call.NodeID != "" {
		metadata["nodeId"] = call.NodeID
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return
	}
	_, _ = c.pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata)
		VALUES ($1, $2, NULLIF($3,''), 'mcp.tool_call', 1, $4)`, uuid.NewString(), call.OrgID, call.RunID, raw)
}
