// MCP connection admin surface — the contract's mcp-routes subset the
// client loop needs: register a connection (create + discovery + audit,
// deliberately NOT one transaction — discovery is network I/O) and the
// per-tool flags toggle (enabled / writeSide / rateLimitPerMin /
// exposeToAi) with change-only audits. Descriptors are born disabled +
// write-side; this route is HOW an admin marks a tool read-only or
// exposes its description to the LLM.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
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
	refsJSON := []byte("{}")
	if body.EnvRefs != nil {
		untrustedJSON, marshalErr := json.Marshal(body.EnvRefs)
		if marshalErr != nil {
			return opError(http.StatusBadRequest, "mcp_env_refs_invalid",
				"envRefs must use the supported closed reference shape", nil)
		}
		parsedRefs, parseErr := mcpclient.ParseEnvRefs(untrustedJSON)
		if parseErr != nil {
			return opError(http.StatusBadRequest, "mcp_env_refs_invalid",
				"envRefs must use the supported closed reference shape", nil)
		}
		// Refuse reserved platform variables at the door. The resolver also
		// refuses them, but persisting one would leave a stored exfiltration
		// attempt that costs a discovery round trip merely to fail.
		for _, ref := range parsedRefs {
			if secretstore.EnvRefAllowed(ref.Name) {
				continue
			}
			return opError(http.StatusBadRequest, "mcp_env_ref_reserved",
				"one or more env refs name a reserved platform variable", nil)
		}
		refsJSON, marshalErr = json.Marshal(parsedRefs)
		if marshalErr != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}

	// Change-only audits, mirroring the contract actions.
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
	s.route(mux, "POST /mcp/connections", routeGate{auth.RoleAdmin, "mcp.connections.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.createMcpConnectionCore(r, rc))
	})
	s.route(mux, "POST /mcp/connections/{alias}/tools/{toolName}", routeGate{auth.RoleAdmin, "mcp.connections.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.setMcpToolFlagsCore(r, rc, r.PathValue("alias"), r.PathValue("toolName")))
	})
	// The admin panel and the mcp_tool step picker both read this to list a
	// connection's cached descriptors. It was never registered, so both
	// resolved the SPA shell and rendered a fabricated "no tools" state that
	// blamed the admin for a route that did not exist.
	s.route(mux, "GET /mcp/connections/{alias}/tools", routeGate{auth.RoleViewer, "mcp.connections.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.listMcpToolsCore(r, rc, r.PathValue("alias")))
	})
	// Connection-level enable/disable and delete. Without these the panel's
	// kill switch was inert and a created connection could never be removed.
	s.route(mux, "POST /mcp/connections/{alias}", routeGate{auth.RoleAdmin, "mcp.connections.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.setMcpConnectionEnabledCore(r, rc, r.PathValue("alias")))
	})
	s.route(mux, "DELETE /mcp/connections/{alias}", routeGate{auth.RoleAdmin, "mcp.connections.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.deleteMcpConnectionCore(r, rc, r.PathValue("alias")))
	})
	s.route(mux, "POST /mcp/connections/{alias}/rediscover", routeGate{auth.RoleAdmin, "mcp.connections.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.rediscoverMcpConnectionCore(r, rc, r.PathValue("alias")))
	})
}

// mcpToolDescriptorView projects a stored descriptor into the camelCase shape
// web/src/types.ts declares. Kept in one place so the tools-list read and any
// future descriptor surface cannot drift into two different wire shapes.
func mcpToolDescriptorView(row store.McpToolDescriptor) map[string]any {
	return map[string]any{
		"id": row.ID, "connectionId": row.ConnectionID, "name": row.Name,
		"description": textOrNull(row.Description), "inputSchema": rawOrNull(row.InputSchema),
		"writeSide": row.WriteSide, "enabled": row.Enabled, "exposeToAi": row.ExposeToAi,
		"rateLimitPerMin": nullableInt(row.RateLimitPerMin),
	}
}

func (s *V1Server) listMcpToolsCore(r *http.Request, rc v1Request, alias string) opResult {
	q := store.New(s.pool)
	connection, err := q.GetMcpConnectionByAlias(r.Context(), store.GetMcpConnectionByAliasParams{
		OrgID: rc.orgID, Alias: alias,
	})
	if err != nil {
		return opError(http.StatusNotFound, "mcp_connection_not_found", "connection not found", nil)
	}
	rows, err := q.ListMcpToolDescriptorsByConnection(r.Context(), connection.ID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	tools := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		tools = append(tools, mcpToolDescriptorView(row))
	}
	return opOK(map[string]any{"connection": map[string]any{
		"id": connection.ID, "alias": connection.Alias, "transport": connection.Transport,
		"enabled": connection.Enabled, "status": connection.Status,
	}, "tools": tools})
}

func (s *V1Server) setMcpConnectionEnabledCore(r *http.Request, rc v1Request, alias string) opResult {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeBody(r, &body); err != nil || body.Enabled == nil {
		return opError(http.StatusBadRequest, "mcp_body_invalid", "enabled must be a boolean", nil)
	}
	id, err := store.New(s.pool).SetMcpConnectionEnabled(r.Context(), store.SetMcpConnectionEnabledParams{
		OrgID: rc.orgID, Alias: alias, Enabled: *body.Enabled,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "mcp_connection_not_found", "connection not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "mcp.connection.updated", audit.Options{
		TargetType: "mcp_connection", TargetID: id,
		Metadata: map[string]any{"alias": alias, "enabled": *body.Enabled},
	})
	return opOK(map[string]any{"alias": alias, "enabled": *body.Enabled})
}

func (s *V1Server) deleteMcpConnectionCore(r *http.Request, rc v1Request, alias string) opResult {
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	// Discovery takes a key-share lock before each descriptor upsert. Holding
	// this row FOR UPDATE makes deletion linearizable with a concurrent network
	// discovery: either discovery commits first and these deletes remove its
	// rows, or it observes the committed deletion and inserts nothing.
	connection, err := q.GetMcpConnectionByAliasForUpdate(ctx, store.GetMcpConnectionByAliasForUpdateParams{
		OrgID: rc.orgID, Alias: alias,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "mcp_connection_not_found", "connection not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if err := q.DeleteMcpToolDescriptorsForConnection(ctx, connection.ID); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	id, err := q.DeleteMcpConnection(ctx, store.DeleteMcpConnectionParams{OrgID: rc.orgID, Alias: alias})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "mcp_connection_not_found", "connection not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if err := audit.WriteInTx(ctx, tx, rc.authContext, "mcp.connection.deleted", audit.Options{
		TargetType: "mcp_connection", TargetID: id, Metadata: map[string]any{"alias": alias},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{"alias": alias, "deleted": true})
}

func (s *V1Server) rediscoverMcpConnectionCore(r *http.Request, rc v1Request, alias string) opResult {
	q := store.New(s.pool)
	if _, err := q.GetMcpConnectionByAlias(r.Context(), store.GetMcpConnectionByAliasParams{
		OrgID: rc.orgID, Alias: alias,
	}); err != nil {
		return opError(http.StatusNotFound, "mcp_connection_not_found", "connection not found", nil)
	}
	// Network I/O, so no surrounding transaction — the same posture as create.
	discovery := s.mcp.RunDiscovery(r.Context(), rc.orgID, alias)
	audit.Write(r.Context(), s.pool, rc.authContext, "mcp.connection.rediscovered", audit.Options{
		TargetType: "mcp_connection", TargetID: alias,
		Metadata: map[string]any{"alias": alias, "discoveryOk": discovery.OK, "tools": discovery.Tools},
	})
	return opOK(map[string]any{"discovery": map[string]any{
		"ok": discovery.OK, "tools": discovery.Tools, "error": discovery.Error,
	}})
}
