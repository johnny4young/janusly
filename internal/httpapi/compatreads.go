// Compatibility read closures: the last routes the real web touches that the
// runtime did not originally serve on the exact wire the client uses. The
// web's api() sends V1_READ_PATHS GETs to /v1 with the envelope (templates,
// schedule-preview, workflows/health, run/usage, memory/consent-status) and
// everything else raw legacy (mcp connections list, recovery
// calibration-status). Each mount here either aliases an existing core onto
// its missing wire or ports the contract handler verbatim. Feature-absent
// surfaces stay documented divergences in docs/architecture/api-contract.md
// rather than stub routes.
package httpapi

import (
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/cron"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

// The reference template catalog (17 entries): the 15 extracted
// VERBATIM from the API contract at the pin plus the horizontal
// finance/people additions — all carrying the i18n nameCode/
// descriptionCode/categoryCode decoration. Same embed-don't-translate
// posture as the solution packs.
//
//go:embed assets/templates.json
var templateCatalogJSON []byte

var templateCatalog = func() []map[string]any {
	var parsed []map[string]any
	if err := json.Unmarshal(templateCatalogJSON, &parsed); err != nil || len(parsed) == 0 {
		panic("embedded template catalog is invalid")
	}
	return parsed
}()

const (
	// calibrationWindowDays / calibrationMinSamples mirror the contract's
	// DEFAULT_CALIBRATION_WINDOW_DAYS / MIN_CALIBRATION_SAMPLES.
	calibrationWindowDays = 30
	calibrationMinSamples = 20
)

// memoryPurgeProjection derives the contract's MemoryPurgeStatus union
// ({status, scheduledFor}) from the runtime's durable state: consent lives
// in org_configs (`memory.enabled` flip time) and the purge is an hourly
// sweep, so "scheduled" is flip time + delay while
// entries remain, and "none" once nothing is left to purge.
func (s *V1Server) memoryPurgeProjection(r *http.Request, rc v1Request, tenantEnabled bool) map[string]any {
	none := map[string]any{"status": "none", "scheduledFor": nil}
	if tenantEnabled {
		return none
	}
	q := store.New(s.pool)
	revoked, err := q.GetOrgConfigRevokedAt(r.Context(), rc.orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return none
	}
	if err != nil || revoked == nil {
		return map[string]any{"status": "unknown", "scheduledFor": nil}
	}
	// Same window the sweep enforces (JANUSLY_MEMORY_PURGE_DELAY_HOURS,
	// default seven days).
	scheduledFor := revoked.Add(engine.MemoryPurgeDelay())
	if time.Now().Before(scheduledFor) {
		return map[string]any{"status": "scheduled", "scheduledFor": scheduledFor.UTC().Format(time.RFC3339)}
	}
	remaining, err := q.CountMemoryEntriesForOrg(r.Context(), rc.orgID)
	if err != nil {
		return map[string]any{"status": "unknown", "scheduledFor": nil}
	}
	if remaining == 0 {
		return none
	}
	return map[string]any{"status": "running", "scheduledFor": scheduledFor.UTC().Format(time.RFC3339)}
}

func (s *V1Server) memoryConsentStatusCore(r *http.Request, rc v1Request) opResult {
	processEnabled := os.Getenv("JANUSLY_MEMORY_ENABLED") == "true"
	tenantEnabled := orgconfig.LoadBool(r.Context(), s.pool, rc.orgID, "memory.enabled")
	return opOK(map[string]any{
		"enabled":        processEnabled && tenantEnabled,
		"processEnabled": processEnabled,
		"tenantEnabled":  tenantEnabled,
		"purge":          s.memoryPurgeProjection(r, rc, tenantEnabled),
	})
}

func (s *V1Server) mountF1SweepRoutes(mux *http.ServeMux) {
	// The AI Studio templates panel (v1 read set).
	mux.HandleFunc("GET /v1/templates", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeV1Data(w, rc.id, templateCatalog)
	}))
	mux.HandleFunc("GET /templates", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(templateCatalog)
	}))

	// Cron preview for the canvas schedule node ({valid, nextFires[3]};
	// invalid input is a VALID {valid:false} answer, never an error).
	schedulePreview := func(r *http.Request) map[string]any {
		invalid := map[string]any{"valid": false, "nextFires": []string{}}
		expression := strings.TrimSpace(r.URL.Query().Get("cron"))
		if expression == "" || len(expression) > 100 {
			return invalid
		}
		if _, err := cron.Parse(expression); err != nil {
			return invalid
		}
		fires := cron.NextFires(expression, time.Now().UTC(), 3)
		if len(fires) != 3 {
			return invalid
		}
		nextFires := make([]string, 0, 3)
		for _, fire := range fires {
			nextFires = append(nextFires, fire.UTC().Format(time.RFC3339))
		}
		return map[string]any{"valid": true, "nextFires": nextFires}
	}
	s.route(mux, "GET /v1/workflows/schedule-preview", routeGate{auth.RoleViewer, "workflows.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeV1Data(w, rc.id, schedulePreview(r))
	})
	s.route(mux, "GET /workflows/schedule-preview", routeGate{auth.RoleViewer, "workflows.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(schedulePreview(r))
	})

	// v1 aliases over existing legacy cores (the wire the web reads).
	s.route(mux, "GET /v1/workflows/health", routeGate{auth.RoleViewer, "workflows.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.workflowHealthCore(r, rc))
	})
	s.route(mux, "GET /v1/run/usage", routeGate{auth.RoleViewer, "runs.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.runUsageCore(r, rc))
	})

	// Memory governance status for the Recovery Center warning card.
	s.route(mux, "GET /v1/memory/consent-status", routeGate{auth.RoleViewer, "recovery.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.memoryConsentStatusCore(r, rc))
	})
	s.route(mux, "GET /memory/consent-status", routeGate{auth.RoleViewer, "recovery.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.memoryConsentStatusCore(r, rc))
	})

	// Calibration posture for the Recovery Center tiles (legacy raw).
	// Mounted through route so the gate and handler registration stay
	// colocated; new modules use this as the exemplar migration.
	s.route(mux, "GET /recovery/calibration-status", routeGate{auth.RoleViewer, "recovery.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		calibrations := s.listCalibrationsCore(r, rc)
		if calibrations.status != http.StatusOK {
			writeUnversioned(w, calibrations)
			return
		}
		calibrationData, _ := calibrations.data.(map[string]any)
		writeUnversioned(w, opOK(map[string]any{
			"enabled":           orgconfig.LoadBool(r.Context(), s.pool, rc.orgID, "ai.confidenceCalibrationEnabled"),
			"windowDays":        calibrationWindowDays,
			"minimumSampleSize": calibrationMinSamples,
			"calibrations":      calibrationData["calibrations"],
		}))
	})

	// MCP connections list for the panel + tool config field (legacy raw;
	// per-connection descriptor counts so the panel avoids N+1 fetches —
	// the contract does the same join in the handler).
	s.route(mux, "GET /mcp/connections", routeGate{auth.RoleViewer, "mcp.connections.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		rows, err := q.ListMcpConnections(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		connectionIDs := make([]string, 0, len(rows))
		for _, row := range rows {
			connectionIDs = append(connectionIDs, row.ID)
		}
		// One grouped count for the whole page: the panel renders totals,
		// so fetching every descriptor per connection was N+1 in queries
		// and in transferred rows.
		counts := map[string]store.CountMcpToolDescriptorsByConnectionRow{}
		if len(connectionIDs) > 0 {
			countRows, err := q.CountMcpToolDescriptorsByConnection(r.Context(), connectionIDs)
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			for _, countRow := range countRows {
				counts[countRow.ConnectionID] = countRow
			}
		}
		connections := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			count := counts[row.ID]
			connections = append(connections, map[string]any{
				"id": row.ID, "alias": row.Alias, "transport": row.Transport,
				"enabled": row.Enabled, "status": row.Status,
				"statusReason": textOrNull(row.StatusReason), "exposeToAi": row.ExposeToAi,
				"lastDiscoveryAt": row.LastDiscoveryAt, "createdAt": row.CreatedAt,
				"toolCount": int(count.Total), "enabledToolCount": int(count.Enabled),
			})
		}
		writeUnversioned(w, opOK(map[string]any{"connections": connections}))
	})
}
