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
	var refs map[string]struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if len(connection.EnvRefs) > 0 {
		_ = json.Unmarshal(connection.EnvRefs, &refs)
	}
	for key, ref := range refs {
		if ref.Kind != "env" {
			continue
		}
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
	ConnectionAlias string `json:"connectionAlias"`
	ToolName        string `json:"toolName"`
	Description     string `json:"description"`
}

// ListExposedToolsForAi returns the org's opted-in tools with sanitized
// descriptions in stable (alias, name) order, bounded by MaxExposedTools
// and MaxExposedDescriptionBytes. Hitting either cap appends the
// contract's synthetic "_truncated" entry so the LLM and the operator
// SEE the truncation instead of a silently clipped list.
func (c *Client) ListExposedToolsForAi(ctx context.Context, orgID string) []ExposedMcpTool {
	rows, err := store.New(c.pool).ListExposedMcpToolsForAi(ctx, orgID)
	if err != nil {
		return []ExposedMcpTool{}
	}
	out := make([]ExposedMcpTool, 0, len(rows))
	totalBytes := 0
	truncated := 0
	for index, row := range rows {
		if len(out) >= MaxExposedTools {
			truncated = len(rows) - index
			break
		}
		description := signature.SanitizeMcpToolDescription(row.Description.String)
		// Guidance-specific secret shapes stack over the signature scrub
		// (same posture as every other prompt-bound surface).
		description = aiguidance.ScrubGuidanceSecrets(description)
		projected := totalBytes + len(description)
		if projected > MaxExposedDescriptionBytes {
			truncated = len(rows) - index
			break
		}
		out = append(out, ExposedMcpTool{
			ConnectionAlias: signature.SanitizeMcpPromptLabel(row.Alias, "unnamed"),
			ToolName:        signature.SanitizeMcpPromptLabel(row.Name, "unnamed"),
			Description:     description,
		})
		totalBytes = projected
	}
	if truncated > 0 {
		out = append(out, ExposedMcpTool{
			ConnectionAlias: "_truncated", ToolName: "_truncated",
			Description: fmt.Sprintf("(%d more truncated — narrow your opt-ins)", truncated),
		})
	}
	return out
}
