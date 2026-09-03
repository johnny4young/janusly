// MCP discovery + AI-awareness exposure, implements the contract's
// mcp-routes runDiscovery and listExposedMcpToolsForAi. Discovery
// connects over the SAME hardened transports as tool execution (SSRF pin,
// stdio sandbox), lists the server's tools, upserts up to
// MaxDiscoveryTools descriptors, and flips the connection status —
// deliberately NOT inside a transaction (network I/O must never hold a
// Postgres tx). The exposure list applies four independent opt-in flags
// (connection enabled + exposeToAi, descriptor enabled + exposeToAi),
// sanitizes every description, and bounds the total prose so a hostile
// server cannot inflate the AI prompt.
package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

// MaxDiscoveryTools caps how many descriptors one discovery persists.
const MaxDiscoveryTools = 200

// MaxExposedTools caps the AI-awareness tool list per org.
const MaxExposedTools = 60

// MaxExposedDescriptionBytes caps the total sanitized prose (UTF-8 bytes)
// the exposure list may carry per org.
const MaxExposedDescriptionBytes = 20_000

// DiscoveryResult is the outcome of one discovery pass.
type DiscoveryResult struct {
	OK    bool
	Tools int
	Error string
}

// RunDiscovery lists the connection's tools and caches their descriptors.
// Never panics; the connection status records the outcome either way.
func (c *Client) RunDiscovery(ctx context.Context, orgID, alias string) DiscoveryResult {
	q := store.New(c.pool)
	connection, err := q.GetMcpConnectionByAlias(ctx, store.GetMcpConnectionByAliasParams{
		OrgID: orgID, Alias: alias,
	})
	if err != nil {
		return DiscoveryResult{OK: false, Error: fmt.Sprintf("mcp connection not found: %s", alias)}
	}
	resolvedEnv, envErr := c.resolveEnvRefs(connection)
	if envErr != "" {
		c.setStatus(ctx, connection, "failed", envErr)
		return DiscoveryResult{OK: false, Error: envErr}
	}

	callCtx, cancel := context.WithTimeout(ctx, defaultTimeoutMs*time.Millisecond)
	defer cancel()
	session, sandbox, err := c.dialSession(callCtx, connection, resolvedEnv)
	if sandbox != nil && sandbox.stopWatchdog != nil {
		defer sandbox.stopWatchdog()
	}
	if err != nil {
		// SDK errors can embed URLs or path-encoded tokens — scrub + cap
		// before the reason reaches status_reason or audit metadata.
		reason := truncate(signature.ScrubSecretShapes(err.Error()), 200)
		c.setStatus(ctx, connection, "failed", reason)
		return DiscoveryResult{OK: false, Error: reason}
	}
	defer func() { _ = session.Close() }()

	listed, err := session.ListTools(callCtx, nil)
	if err != nil {
		reason := truncate(signature.ScrubSecretShapes(err.Error()), 200)
		c.setStatus(ctx, connection, "failed", reason)
		return DiscoveryResult{OK: false, Error: reason}
	}
	tools := listed.Tools
	if len(tools) > MaxDiscoveryTools {
		tools = tools[:MaxDiscoveryTools]
	}
	for _, tool := range tools {
		var schemaJSON []byte
		if tool.InputSchema != nil {
			schemaJSON, _ = json.Marshal(tool.InputSchema)
		}
		description := pgtype.Text{}
		if tool.Description != "" {
			description = pgtype.Text{String: tool.Description, Valid: true}
		}
		// write_side defaults TRUE (fail-safe) and enabled defaults FALSE:
		// a freshly discovered tool cannot run or reach a prompt until an
		// admin opts it in. The upsert only refreshes prose + schema.
		_ = q.UpsertMcpToolDescriptor(ctx, store.UpsertMcpToolDescriptorParams{
			ID: uuid.NewString(), ConnectionID: connection.ID, Name: tool.Name,
			Description: description, InputSchema: schemaJSON,
			WriteSide: true, Enabled: false,
		})
	}
	c.setStatus(ctx, connection, "active", "")
	return DiscoveryResult{OK: true, Tools: len(tools)}
}

func (c *Client) setStatus(ctx context.Context, connection store.McpConnection, status, reason string) {
	reasonText := pgtype.Text{}
	if reason != "" {
		reasonText = pgtype.Text{String: reason, Valid: true}
	}
	now := time.Now().UTC()
	_ = store.New(c.pool).SetMcpConnectionStatus(ctx, store.SetMcpConnectionStatusParams{
		OrgID: connection.OrgID, ID: connection.ID,
		Status: status, StatusReason: reasonText, LastDiscoveryAt: &now,
	})
}

// resolveEnvRefs mirrors Execute's env-ref pass (generic errors, CRLF
// rejection) for the discovery path.
func (c *Client) resolveEnvRefs(connection store.McpConnection) (map[string]string, string) {
	resolved := map[string]string{}
	refs, err := ParseEnvRefs(connection.EnvRefs)
	if err != nil {
		return nil, "mcp credential references invalid"
	}
	for key, ref := range refs {
		value, err := lookupEnvRef(ref.Name)
		if err != "" {
			return nil, fmt.Sprintf("%s for %s", err, key)
		}
		resolved[key] = value
	}
	return resolved, ""
}

// ExposedMcpTool is one AI-awareness entry: sanitized label + prose.
type ExposedMcpTool struct {
	ConnectionAlias string                 `json:"connectionAlias"`
	ToolName        string                 `json:"toolName"`
	Description     string                 `json:"description"`
	WriteSide       bool                   `json:"writeSide"`
	InputFields     []ExposedMcpInputField `json:"inputFields"`
}

// ExposedMcpInputField is the prompt-safe projection of one input-schema
// property. External descriptions, examples and nested schema prose are never
// passed to the model; only bounded names, primitive types and requiredness.
type ExposedMcpInputField struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

// ListExposedToolsForAi returns the org's opted-in tools with sanitized
// descriptions in stable (alias, name) order, bounded by MaxExposedTools
// and MaxExposedDescriptionBytes. Hitting either cap appends the
// contract's synthetic "_truncated" entry so the LLM and the operator
// SEE the truncation instead of a silently clipped list.
func (c *Client) ListExposedToolsForAi(ctx context.Context, orgID string) []ExposedMcpTool {
	tools, _ := c.ListExposedToolsForCatalog(ctx, orgID)
	return tools
}

// ListExposedToolsForCatalog preserves discovery failure as an explicit
// signal. AI prompt enrichment intentionally retains the historical empty-on-
// failure posture, while the operator-facing CapabilityCatalog must distinguish
// "no opted-in tools" from "the tenant catalog could not be read".
func (c *Client) ListExposedToolsForCatalog(ctx context.Context, orgID string) ([]ExposedMcpTool, error) {
	rows, err := store.New(c.pool).ListExposedMcpToolsForAi(ctx, orgID)
	if err != nil {
		return []ExposedMcpTool{}, err
	}
	out := make([]ExposedMcpTool, 0, len(rows))
	totalBytes := 0
	truncated := 0
	for index, row := range rows {
		if len(out) >= MaxExposedTools {
			truncated += len(rows) - index
			break
		}
		// Runtime config needs the canonical alias and tool name byte-for-byte.
		// Never hand the model a lossy sanitized label that would look callable
		// but fail descriptor lookup at execution time. Unsafe legacy rows remain
		// available to operators in the Inspector, just not to AI generation.
		alias := signature.SanitizeMcpPromptLabel(row.Alias, "")
		toolName := signature.SanitizeMcpPromptLabel(row.Name, "")
		if alias != row.Alias || toolName != row.Name {
			truncated++
			continue
		}
		description := signature.SanitizeMcpToolDescription(row.Description.String)
		// Guidance-specific secret shapes stack over the signature scrub
		// (same posture as every other prompt-bound surface).
		description = aiguidance.ScrubGuidanceSecrets(description)
		projected := totalBytes + len(description)
		if projected > MaxExposedDescriptionBytes {
			truncated += len(rows) - index
			break
		}
		out = append(out, ExposedMcpTool{
			ConnectionAlias: alias,
			ToolName:        toolName,
			Description:     description,
			WriteSide:       row.WriteSide,
			InputFields:     projectMcpInputFields(row.InputSchema),
		})
		totalBytes = projected
	}
	if truncated > 0 {
		out = append(out, ExposedMcpTool{
			ConnectionAlias: "_truncated", ToolName: "_truncated",
			Description: fmt.Sprintf("(%d more truncated — narrow your opt-ins)", truncated),
			InputFields: []ExposedMcpInputField{},
		})
	}
	return out, nil
}

const maxExposedInputFields = 30

func projectMcpInputFields(raw json.RawMessage) []ExposedMcpInputField {
	var schema struct {
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &schema) != nil {
		return []ExposedMcpInputField{}
	}
	required := map[string]bool{}
	for _, name := range schema.Required {
		required[name] = true
	}
	names := make([]string, 0, len(schema.Properties))
	for name := range schema.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	fields := make([]ExposedMcpInputField, 0, min(len(names), maxExposedInputFields))
	for _, name := range names {
		if len(fields) == maxExposedInputFields {
			break
		}
		promptName := signature.SanitizeMcpPromptLabel(name, "")
		if promptName != name {
			continue
		}
		fieldType := schema.Properties[name].Type
		switch fieldType {
		case "string", "number", "integer", "boolean", "object", "array":
		default:
			fieldType = "unknown"
		}
		fields = append(fields, ExposedMcpInputField{
			Name: promptName,
			Type: fieldType, Required: required[name],
		})
	}
	return fields
}
