// The v1 API surface, shaped against captured reference goldens
// (conformance/goldens/node): every response wraps in the
// {apiVersion, requestId, data|error} envelope with an X-Request-Id header;
// unknown and cross-org runs are an indistinguishable 403 runs_forbidden;
// error bodies carry {code, message, params?}. Dev auth mirrors the
// reference's dev-header mode: x-org-id / x-user-id.
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/mcpclient"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
)

// V1Server owns the /v1 route surface over one engine and pool.
type V1Server struct {
	engine         *engine.Engine
	pool           *pgxpool.Pool
	newID          func() string
	hub            *streamHub
	resolver       *auth.Resolver
	limiter        *ratelimit.Limiter
	limiterTracker *ratelimit.Tracker
	queueCache     *queueHealthCache
	mcp            *mcpclient.Client
}

// NewV1Handler mounts the v1 routes plus /healthz. The stream hub's
// LISTEN connection lives for the process (the production shape).
func NewV1Handler(eng *engine.Engine, pool *pgxpool.Pool) http.Handler {
	handler, _ := NewV1HandlerWithShutdown(eng, pool)
	return handler
}

// NewV1HandlerWithShutdown additionally returns a shutdown func that
// cancels the stream hub's hijacked LISTEN connection. Test harnesses MUST
// call it: the hijacked conn is invisible to pool.Close, so without the
// cancel every harness leaks one Postgres connection for the binary's
// lifetime (the "too many clients" suite failure under a live soak).
func NewV1HandlerWithShutdown(eng *engine.Engine, pool *pgxpool.Pool) (http.Handler, func()) {
	server := &V1Server{engine: eng, pool: pool, resolver: auth.NewResolver(pool, auth.ConfigFromEnv()), newID: uuid.NewString, hub: newStreamHub()}
	server.limiterTracker = ratelimit.NewTracker(pool)
	server.limiter = ratelimit.New(pool, ratelimit.Hooks{
		OnError: server.limiterTracker.RecordError, OnSuccess: server.limiterTracker.RecordRecovery,
	})
	server.queueCache = &queueHealthCache{read: server.readQueueSnapshot}
	server.mcp = mcpclient.New(pool, server.limiter)
	hubCtx, cancelHub := context.WithCancel(context.Background())
	go server.hub.listen(hubCtx, pool)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// Legacy public health — the web's OperationsPage polls this every 20s.
	// Public-safe shape from the reference: no raw bucket/error/key detail.
	// rateLimiter is the degradation tracker's public snapshot; queue
	// reflects a real bounded DB probe.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		w.Header().Set("Content-Type", "application/json")
		payload, _ := json.Marshal(map[string]any{
			"ok":          true,
			"rateLimiter": server.limiterTracker.Public(),
			"queue":       server.publicQueueHealth(ctx),
		})
		_, _ = w.Write(payload)
	})
	// Org-config read: the full closed catalog with layered effective
	// values (tenant row → env → default) and provenance per key.
	mux.HandleFunc("GET /org/config", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.listOrgConfigCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/workflows/save", server.auth(server.saveWorkflow))
	mux.HandleFunc("POST /v1/workflows/rollback", server.auth(server.rollbackWorkflow))
	mux.HandleFunc("POST /v1/workflows/readiness", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/readiness", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/validate", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.validateCore(r, rc))
	}))
	mux.HandleFunc("POST /validate", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.validateCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/{id}/resume", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.resumeWorkflowCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("POST /v1/workflows/{id}/resume", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.resumeWorkflowCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("GET /v1/workflows", server.auth(server.listWorkflows))
	mux.HandleFunc("GET /v1/workflows/latest", server.auth(server.latestWorkflowVersion))
	mux.HandleFunc("GET /v1/workflows/versions", server.auth(server.listWorkflowVersions))
	mux.HandleFunc("POST /v1/start", server.auth(server.startRun))
	mux.HandleFunc("POST /v1/webhooks/{workflowId}", server.auth(server.ingestWebhook))
	mux.HandleFunc("POST /v1/triggers/email/ingest", server.auth(server.ingestEmail))
	mux.HandleFunc("POST /v1/triggers/file/ingest", server.auth(server.ingestFileDropped))
	mux.HandleFunc("POST /v1/triggers/mcp/ingest", server.auth(server.ingestMcpEvent))
	mux.HandleFunc("GET /v1/run", server.auth(server.getRun))
	mux.HandleFunc("GET /v1/status", server.auth(server.getRun))
	mux.HandleFunc("GET /v1/runs", server.auth(server.listRuns))
	mux.HandleFunc("POST /v1/resume", server.auth(server.resumeRun))
	mux.HandleFunc("POST /v1/run/cancel", server.auth(server.cancelRun))
	mux.HandleFunc("GET /v1/dlq", server.auth(server.listDeadLetters))
	mux.HandleFunc("POST /runs/redrive", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.runsRedriveCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/runs/redrive", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.runsRedriveCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/recovery/metrics", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.recoveryMetricsCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/metrics", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.recoveryMetricsCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/dlq/clusters", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.clustersCore(r, rc))
	}))
	mux.HandleFunc("GET /dlq/clusters", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.clustersCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/dlq/redrive", server.auth(server.redrive))
	mux.HandleFunc("POST /v1/dlq/replay", server.auth(server.replayAlias))
	mux.HandleFunc("GET /runs/{runId}/stream", server.auth(server.streamRun))
	mux.HandleFunc("GET /auth/context", server.auth(server.authContext))
	// The AI Studio's tool catalog; the web calls it through /v1.
	mux.HandleFunc("GET /v1/tools", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeV1Data(w, rc.id, executors.NewToolRegistry().Catalog())
	}))
	mux.HandleFunc("GET /tools", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(executors.NewToolRegistry().Catalog())
	}))
	server.legacyMutations(mux)
	server.mountCampaignRoutes(mux)
	server.mountMemberRoutes(mux)
	server.mountRoleRoutes(mux)
	server.mountAuditRoutes(mux)
	server.mountOrgConfigRoutes(mux)
	server.mountRunUsageRoutes(mux)
	server.mountSystemHealthRoutes(mux)
	server.mountAiGenerateRoutes(mux)
	server.mountPromptRoutes(mux)
	server.mountMcpRoutes(mux)
	server.mountValidateFixRoutes(mux)
	server.mountPlaybookRoutes(mux)
	server.mountDrillRoutes(mux)
	server.mountFeedbackRoutes(mux)
	server.mountRecoveryItemRoutes(mux)
	server.mountRecoveryQueueRoutes(mux)
	server.mountBulkRecoveryRoutes(mux)
	server.mountRecoveryHomeRoutes(mux)
	server.mountAlertRoutes(mux)
	server.mountReportRoutes(mux)
	server.mountRolloutRoutes(mux)
	server.mountCredentialRoutes(mux)
	server.mountSlackInteractionRoutes(mux)
	server.mountExternalRuntimeRoutes(mux)
	server.mountUpstreamHealthRoutes(mux)
	server.mountAutoHealingRoutes(mux)
	server.mountProductSurfaceRoutes(mux)
	server.mountWorkflowHealthRoutes(mux)
	server.mountWorkflowMetadataRoutes(mux)
	server.mountEvalRoutes(mux)
	server.mountScimRoutes(mux)
	server.mountF1SweepRoutes(mux)
	server.mountAiPatchRoutes(mux)
	server.mountAiSurfaceRoutes(mux)
	server.mountBillingRoutes(mux)
	server.mountReplayLabRoutes(mux)
	server.mountRecoveryReadRoutes(mux)
	return WithBrowserHeaders(mux), cancelHub
}

type v1Request struct {
	orgID  string
	userID string
	id     string
	// authContext carries mode/source/role for audit + permissions.
	authContext *auth.Context
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, rc v1Request)

// auth is the pilot's dev-header gate: the org header is the tenancy scope
// every handler filters by.
func (s *V1Server) auth(next handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestID := requestIDFrom(r)
		resolved, err := s.resolver.Resolve(r.Context(), r)
		if err != nil {
			writeV1Error(w, requestID, http.StatusInternalServerError, "internal_error",
				"Internal error: "+err.Error(), nil)
			return
		}
		if resolved == nil {
			// The reference's 401: message and code from the dispatcher's
			// curated-error path.
			writeV1Error(w, requestID, http.StatusUnauthorized, "server_request_failed",
				"Unauthorized: missing Supabase JWT or dev headers", nil)
			return
		}
		rc := v1Request{
			orgID: resolved.OrgID, userID: resolved.UserID, id: requestID,
			authContext: resolved,
		}
		// Central authorization: the matched mux pattern indexes the
		// annotated registry; role first, then permission — the
		// reference dispatcher's order. Wire-aware rejection bodies.
		if gate, gatedRoute := routeAuthz[r.Pattern]; gatedRoute {
			if rejection := s.checkGate(r, rc, gate); rejection != nil {
				if strings.HasPrefix(r.URL.Path, "/v1/") {
					writeVersioned(w, rc.id, *rejection)
				} else {
					writeLegacy(w, *rejection)
				}
				return
			}
		} else if !authOnlyRoutes[r.Pattern] {
			// Fail CLOSED (T-525): an authenticated mount whose pattern is
			// in neither table is a missing registry entry, not a grant.
			rejection := opError(http.StatusInternalServerError, "route_not_registered",
				"route "+r.Pattern+" is mounted with auth but has no registry gate", nil)
			if strings.HasPrefix(r.URL.Path, "/v1/") {
				writeVersioned(w, rc.id, rejection)
			} else {
				writeLegacy(w, rejection)
			}
			return
		}
		next(w, r, rc)
	}
}
