// Org-config surface over the closed catalog, ported from the reference's
// org routes: GET lists every definition with its layered effective value
// (tenant row → env override → catalog default, with provenance), POST
// validates one (key, value) through the catalog pipeline — unknown keys,
// type mismatches, out-of-range numbers, and secret-shaped values all
// reject — then upserts the tenant row and audits org.config.updated.
// GET is auth-only (any member reads effective settings); POST is
// admin + org.config.write in the central registry.
package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

func (s *V1Server) listOrgConfigCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListOrgConfigRows(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	tenantRows := make(map[string]json.RawMessage, len(rows))
	updatedAt := map[string]any{}
	for _, row := range rows {
		tenantRows[row.Key] = row.ValueJson
		updatedAt[row.Key] = timeOrNull(row.UpdatedAt)
	}
	resolved := orgconfig.ResolveAll(tenantRows, os.LookupEnv)
	entries := make([]map[string]any, 0, len(resolved))
	for _, entry := range resolved {
		view := orgConfigEntryView(entry.Definition, rc.orgID, entry.Value, entry.Source, nil)
		if entry.Source == "tenant" {
			view["updatedAt"] = updatedAt[entry.Key]
		}
		entries = append(entries, view)
	}
	return opOK(map[string]any{"config": entries})
}

func (s *V1Server) updateOrgConfigCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if err := decodeBody(r, &body); err != nil || body.Key == "" {
		return opError(http.StatusBadRequest, "org_key_required", "key is required", nil)
	}
	if len(body.Value) == 0 {
		return opError(http.StatusBadRequest, "org_value_required", "value is required", nil)
	}
	def := orgconfig.Get(body.Key)
	if def == nil {
		return opError(http.StatusBadRequest, "org_config_invalid",
			"Unknown org config key: "+body.Key, nil)
	}
	var decoded any
	if err := json.Unmarshal(body.Value, &decoded); err != nil {
		return opError(http.StatusBadRequest, "org_config_invalid", "value is not valid JSON", nil)
	}
	normalized, err := orgconfig.Normalize(def, decoded)
	if err != nil {
		return opError(http.StatusBadRequest, "org_config_invalid", err.Error(), nil)
	}
	valueJSON, err := json.Marshal(normalized)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	ctx := r.Context()
	var previousMemoryEnabled *bool
	previousMemorySource := ""
	if def.Key == "memory.enabled" {
		if resolved, loadErr := orgconfig.LoadResolved(ctx, s.pool, rc.orgID); loadErr == nil {
			for _, entry := range resolved {
				if entry.Key == def.Key {
					if previous, ok := entry.Value.(bool); ok {
						previousMemoryEnabled = &previous
						previousMemorySource = entry.Source
					}
					break
				}
			}
		}
	}
	if err := store.New(s.pool).UpsertOrgConfigValue(ctx, store.UpsertOrgConfigValueParams{
		ID: s.newID(), OrgID: rc.orgID, Key: def.Key, ValueJson: valueJSON,
		Category: def.Category, Description: def.Description, ValueType: def.ValueType,
		UpdatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	// ai.operatorGuidance summarizes instead of echoing operator prose into
	// the trail, like the reference.
	metadata := map[string]any{"key": def.Key, "value": normalized}
	if def.Key == "ai.operatorGuidance" {
		text, _ := normalized.(string)
		metadata = map[string]any{"key": def.Key, "bytes": len(text)}
	}
	audit.Write(ctx, s.pool, rc.authContext, "org.config.updated", audit.Options{
		TargetType: "org_config", TargetID: def.Key, Metadata: metadata,
	})
	if def.Key == "memory.enabled" && previousMemoryEnabled != nil {
		if enabled, ok := normalized.(bool); ok && enabled != *previousMemoryEnabled {
			transition := map[string]any{
				"previousValue": *previousMemoryEnabled,
				"newValue":      enabled,
			}
			action := audit.Action("memory.consent.revoked")
			if enabled {
				action = "memory.consent.granted"
				// The false config row is the Go due-clock. Replacing it with
				// true removes the org from the purge sweep atomically, so a
				// pending deadline was cancelled without queue bookkeeping.
				transition["pendingPurgeCancelled"] = previousMemorySource == "tenant"
			}
			audit.Write(ctx, s.pool, rc.authContext, action, audit.Options{
				TargetType: "org_config", TargetID: def.Key, Metadata: transition,
			})
		}
	}
	return opOK(orgConfigEntryView(*def, rc.orgID, normalized, "tenant",
		time.Now().UTC().Format(time.RFC3339Nano)))
}

// orgConfigEntryView is the reference's full config-row projection, shared
// by the list read and the write echo (allowEmpty/fractional emitted only
// when true, matching the reference's omit-false serialization).
func orgConfigEntryView(def orgconfig.Definition, orgID string, value any, source string, updatedAt any) map[string]any {
	view := map[string]any{
		"key": def.Key, "category": def.Category, "description": def.Description,
		"valueType": def.ValueType, "defaultValue": def.Default,
		"orgId": orgID, "value": value, "source": source,
		"updatedAt": updatedAt,
	}
	if len(def.EnvKeys) > 0 {
		view["envKeys"] = def.EnvKeys
	}
	if len(def.AllowedValues) > 0 {
		view["allowedValues"] = def.AllowedValues
	}
	if def.Min != nil {
		view["min"] = *def.Min
	}
	if def.Max != nil {
		view["max"] = *def.Max
	}
	if def.AllowEmpty {
		view["allowEmpty"] = true
	}
	if def.Fractional {
		view["fractional"] = true
	}
	return view
}

func (s *V1Server) mountOrgConfigRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /org/config", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.updateOrgConfigCore(r, rc))
	}))
}
