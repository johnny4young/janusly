// MCP connection admin surface — the reference's mcp-routes subset the
// client loop needs: register a connection (create + discovery + audit,
// deliberately NOT one transaction — discovery is network I/O) and the
// per-tool flags toggle (enabled / writeSide / rateLimitPerMin /
// exposeToAi) with change-only audits. Descriptors are born disabled +
// write-side; this route is HOW an admin marks a tool read-only or
// exposes its description to the LLM.
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/store"
)

var mcpTransports = map[string]bool{"stdio": true, "sse": true, "http": true}

func (s *V1Server) createMcpConnectionCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Alias     string            `json:"alias"`
		Transport string            `json:"transport"`
		Command   string            `json:"command"`
		Args      []string          `json:"args"`
		URL       string            `json:"url"`
		EnvRefs   map[string]any    `json:"envRefs"`
		Headers   map[string]string `json:"-"`
	}
	if err := decodeBody(r, &body); err != nil || body.Alias == "" || len(body.Alias) > 120 {
		return opError(http.StatusBadRequest, "mcp_alias_invalid", "alias is required (1..120 chars)", nil)
	}
	if !mcpTransports[body.Transport] {
		return opError(http.StatusBadRequest, "mcp_transport_invalid",
			"transport must be one of stdio, sse, http", nil)
	}
	ctx := r.Context()
	switch body.Transport {
	case "stdio":
		if body.Command == "" {
			return opError(http.StatusBadRequest, "mcp_command_required", "stdio transport requires command", nil)
		}
		// Fail-closed: no stdio connection may be created unless the
		// command is already allowlisted (env or tenant CSV).
		allowlist, _ := orgconfig.LoadValue(ctx, s.pool, rc.orgID, "mcp.clientCommandAllowlist").(string)
		allowed := false
		for entry := range strings.SplitSeq(allowlist, ",") {
			if strings.TrimSpace(entry) == body.Command {
				allowed = true
				break
			}
		}
		if !allowed {
			return opError(http.StatusBadRequest, "mcp_command_not_allowlisted",
				"command is not in the stdio allowlist", nil)
		}
	default:
		parsed, err := url.Parse(body.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return opError(http.StatusBadRequest, "mcp_url_invalid", "url must be a valid http(s) URL", nil)
		}
	}

	q := store.New(s.pool)
	if _, err := q.GetMcpConnectionByAlias(ctx, store.GetMcpConnectionByAliasParams{
		OrgID: rc.orgID, Alias: body.Alias,
	}); err == nil {
		return opError(http.StatusConflict, "mcp_alias_duplicate", "a connection with this alias already exists", nil)
	}
	argsJSON, _ := json.Marshal(body.Args)
	if body.Args == nil {
		argsJSON = []byte("[]")
	}
	refsJSON, _ := json.Marshal(body.EnvRefs)
	if body.EnvRefs == nil {
		refsJSON = []byte("{}")
	}
	id := s.newID()
	if err := q.InsertMcpConnection(ctx, store.InsertMcpConnectionParams{
		ID: id, OrgID: rc.orgID, Alias: body.Alias, Transport: body.Transport,
		Command: pgtype.Text{String: body.Command, Valid: body.Command != ""},
		Args:    argsJSON,
		Url:     pgtype.Text{String: body.URL, Valid: body.URL != ""},
		EnvRefs: refsJSON, Enabled: true, Status: "pending",
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	// create + discovery + audit stay UNTRANSACTED: discovery is network
	// I/O (child spawn / HTTP) and must never hold a Postgres tx. The
	// row's status=pending already signals "discovery in progress".
	discovery := s.mcp.RunDiscovery(ctx, rc.orgID, body.Alias)
	audit.Write(ctx, s.pool, rc.authContext, "mcp.connection.created", audit.Options{
		TargetType: "mcp_connection", TargetID: id, Metadata: map[string]any{
			"alias": body.Alias, "transport": body.Transport,
			"discoveryOk": discovery.OK, "tools": discovery.Tools,
		},
	})
	connection, err := q.GetMcpConnectionByAlias(ctx, store.GetMcpConnectionByAliasParams{
		OrgID: rc.orgID, Alias: body.Alias,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opResult{status: http.StatusCreated, data: map[string]any{"connection": map[string]any{
		"id": connection.ID, "alias": connection.Alias, "transport": connection.Transport,
		"status": connection.Status, "statusReason": textOrNull(connection.StatusReason),
		"discovery": map[string]any{"ok": discovery.OK, "tools": discovery.Tools, "error": discovery.Error},
	}}}
}

func (s *V1Server) setMcpToolFlagsCore(r *http.Request, rc v1Request, alias, toolName string) opResult {
	ctx := r.Context()
	q := store.New(s.pool)
	connection, err := q.GetMcpConnectionByAlias(ctx, store.GetMcpConnectionByAliasParams{
		OrgID: rc.orgID, Alias: alias,
	})
	if err != nil {
		return opError(http.StatusNotFound, "mcp_connection_not_found", "connection not found", nil)
	}
	before, err := q.GetMcpToolDescriptor(ctx, store.GetMcpToolDescriptorParams{
		ConnectionID: connection.ID, Name: toolName,
	})
	if err != nil {
		if err == pgx.ErrNoRows {
			return opError(http.StatusNotFound, "mcp_tool_not_found", "tool not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	var body map[string]json.RawMessage
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "mcp_body_invalid", "invalid JSON body", nil)
	}
	merged := before
	touched := false
	readBool := func(key string) (bool, bool, opResult) {
		raw, present := body[key]
		if !present {
			return false, false, opResult{}
		}
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return false, false, opError(http.StatusBadRequest, "mcp_field_invalid", key+" must be a boolean", nil)
		}
		return value, true, opResult{}
	}
	enabled, hasEnabled, errRes := readBool("enabled")
	if errRes.status != 0 {
		return errRes
	}
	writeSide, hasWriteSide, errRes := readBool("writeSide")
	if errRes.status != 0 {
		return errRes
	}
	exposeToAi, hasExpose, errRes := readBool("exposeToAi")
	if errRes.status != 0 {
		return errRes
	}
	if hasEnabled {
		merged.Enabled = enabled
		touched = true
	}
	if hasWriteSide {
		merged.WriteSide = writeSide
		touched = true
	}
	if hasExpose {
		merged.ExposeToAi = exposeToAi
		touched = true
	}
	// rateLimitPerMin: absent → keep; null → clear; int in [1,10000] → set.
	if raw, present := body["rateLimitPerMin"]; present {
		trimmed := strings.TrimSpace(string(raw))
		if trimmed == "null" {
			merged.RateLimitPerMin = pgtype.Int4{}
		} else {
			var value float64
			if err := json.Unmarshal(raw, &value); err != nil || value != float64(int(value)) ||
				value < 1 || value > 10_000 {
				return opError(http.StatusBadRequest, "mcp_rate_limit_invalid",
					"rateLimitPerMin must be null or an integer in [1, 10000]", nil)
			}
			merged.RateLimitPerMin = pgtype.Int4{Int32: int32(value), Valid: true}
		}
		touched = true
	}
	if !touched {
		return opError(http.StatusBadRequest, "mcp_no_updatable_fields", "no updatable fields provided", nil)
	}

	after, err := q.UpdateMcpToolFlags(ctx, store.UpdateMcpToolFlagsParams{
		ConnectionID: connection.ID, Name: toolName,
		Enabled: merged.Enabled, WriteSide: merged.WriteSide,
		RateLimitPerMin: merged.RateLimitPerMin, ExposeToAi: merged.ExposeToAi,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	// Change-only audits, mirroring the reference actions.
	if hasEnabled && before.Enabled != after.Enabled {
		action := audit.Action("mcp.tool.disabled")
		if after.Enabled {
			action = audit.Action("mcp.tool.enabled")
		}
		audit.Write(ctx, s.pool, rc.authContext, action, audit.Options{
			TargetType: "mcp_tool", TargetID: before.ID,
			Metadata: map[string]any{"alias": alias, "toolName": toolName, "writeSide": after.WriteSide},
		})
	}
	if before.RateLimitPerMin != after.RateLimitPerMin {
		audit.Write(ctx, s.pool, rc.authContext, "mcp.tool.rate_limit_set", audit.Options{
			TargetType: "mcp_tool", TargetID: before.ID,
			Metadata: map[string]any{
				"alias": alias, "toolName": toolName,
				"before": int4OrNull(before.RateLimitPerMin), "after": int4OrNull(after.RateLimitPerMin),
			},
		})
	}
	if hasExpose && before.ExposeToAi != after.ExposeToAi {
		audit.Write(ctx, s.pool, rc.authContext, "mcp.tool.expose_to_ai_set", audit.Options{
			TargetType: "mcp_tool", TargetID: before.ID,
			Metadata: map[string]any{"alias": alias, "toolName": toolName, "exposeToAi": after.ExposeToAi},
		})
	}
	return opOK(map[string]any{"tool": map[string]any{
		"name": after.Name, "enabled": after.Enabled, "writeSide": after.WriteSide,
		"rateLimitPerMin": int4OrNull(after.RateLimitPerMin), "exposeToAi": after.ExposeToAi,
	}})
}

func int4OrNull(value pgtype.Int4) any {
	if !value.Valid {
		return nil
	}
	return value.Int32
}

func (s *V1Server) mountMcpRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /mcp/connections", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createMcpConnectionCore(r, rc))
	}))
	mux.HandleFunc("POST /mcp/connections/{alias}/tools/{toolName}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.setMcpToolFlagsCore(r, rc, r.PathValue("alias"), r.PathValue("toolName")))
	}))
}
