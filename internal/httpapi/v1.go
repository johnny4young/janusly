// The v1 API surface, shaped against captured reference goldens
// (conformance/goldens/node): every response wraps in the
// {apiVersion, requestId, data|error} envelope with an X-Request-Id header;
// unknown and cross-org runs are an indistinguishable 403 runs_forbidden;
// error bodies carry {code, message, params?}. Dev auth mirrors the
// contract's dev-header mode: x-org-id / x-user-id.
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	contractdoc "github.com/johnny4young/janusly/contract"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/authpolicy"
	"github.com/johnny4young/janusly/internal/browsersession"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/webdist"
	"github.com/johnny4young/janusly/internal/workos"
)

type workosClient interface {
	BuildAuthorizeURL(connectionID, redirectURI, state string) (string, error)
	ExchangeCode(context.Context, string, string) (workos.Profile, error)
}

// V1Server owns the /v1 route surface over one engine and pool.
type V1Server struct {
	engine         *engine.Engine
	pool           *pgxpool.Pool
	newID          func() string
	hub            *streamHub
	resolver       *auth.Resolver
	authPolicy     *authpolicy.Evaluator
	limiter        *ratelimit.Limiter
	limiterTracker *ratelimit.Tracker
	queueCache     *queueHealthCache
	mcp            *mcpclient.Client
	workos         workosClient
	background     context.Context
	backgroundWG   sync.WaitGroup
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
	return newV1HandlerWithWorkOS(eng, pool, workos.NewFromEnv())
}

func newV1HandlerWithWorkOS(eng *engine.Engine, pool *pgxpool.Pool, client workosClient) (http.Handler, func()) {
	serverCtx, cancelServer := context.WithCancel(context.Background())
	server := &V1Server{
		engine: eng, pool: pool, resolver: auth.NewResolver(pool, auth.ConfigFromEnv()),
		newID: uuid.NewString, hub: newStreamHub(), workos: client, background: serverCtx,
	}
	server.authPolicy = authpolicy.New(pool)
	server.resolver.SetPolicyEvaluator(func(ctx context.Context, input auth.PolicyInput) bool {
		return server.authPolicy.Evaluate(ctx, authpolicy.Input{
			OrgID: input.OrgID, UserID: input.UserID, Email: input.Email, Mode: input.Mode,
		}).Allowed
	})
	server.limiterTracker = ratelimit.NewTracker(pool)
	server.limiter = ratelimit.New(pool, ratelimit.Hooks{
		OnError: server.limiterTracker.RecordError, OnSuccess: server.limiterTracker.RecordRecovery,
	})
	server.queueCache = &queueHealthCache{read: server.readQueueSnapshot}
	server.mcp = mcpclient.New(pool, server.limiter)
	go server.hub.listen(serverCtx, pool)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// Public generated contract. Exact mux patterns win before the embedded
	// SPA catch-all and the bytes are the same artifact `make ci` drift-checks.
	mux.HandleFunc("GET /v1/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(contractdoc.OpenAPI)
	})
	// Legacy public health — the web's OperationsPage polls this every 20s.
	// Public-safe shape from the contract: no raw bucket/error/key detail.
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
		writeUnversioned(w, server.listOrgConfigCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/workflows/save", server.auth(server.saveWorkflow))
	mux.HandleFunc("POST /v1/workflows/rollback", server.auth(server.rollbackWorkflow))
	mux.HandleFunc("POST /v1/workflows/readiness", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/readiness", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, server.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/validate", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.validateCore(r, rc))
	}))
	mux.HandleFunc("POST /validate", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, server.validateCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/{id}/resume", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, server.resumeWorkflowCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("POST /v1/workflows/{id}/resume", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.resumeWorkflowCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("GET /v1/workflows", server.auth(server.listWorkflows))
	mux.HandleFunc("GET /v1/workflows/latest", server.auth(server.latestWorkflowVersion))
	mux.HandleFunc("GET /v1/workflows/versions", server.auth(server.listWorkflowVersions))
	mux.HandleFunc("POST /v1/start", server.auth(server.startRun))
	mux.HandleFunc("POST /triggers/webhook/ingest", server.auth(server.ingestWebhookBySelector))
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
		writeUnversioned(w, server.runsRedriveCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/runs/redrive", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.runsRedriveCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/recovery/metrics", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.recoveryMetricsCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/metrics", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, server.recoveryMetricsCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/dlq/clusters", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.clustersCore(r, rc))
	}))
	mux.HandleFunc("GET /dlq/clusters", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, server.clustersCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/dlq/redrive", server.auth(server.redrive))
	mux.HandleFunc("POST /v1/dlq/replay", server.auth(server.replayAlias))
	mux.HandleFunc("GET /runs/{runId}/stream", server.auth(server.streamRun))
	mux.HandleFunc("GET /auth/context", server.identity(server.authContext))
	// The AI Studio's tool catalog; the web calls it through /v1.
	mux.HandleFunc("GET /v1/tools", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeV1Data(w, rc.id, executors.NewToolRegistry().Catalog())
	}))
	mux.HandleFunc("GET /tools", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(executors.NewToolRegistry().Catalog())
	}))
	server.unversionedRoutes(mux)
	server.mountCampaignRoutes(mux)
	server.mountMemberRoutes(mux)
	server.mountRoleRoutes(mux)
	server.mountAuditRoutes(mux)
	server.mountOrgConfigRoutes(mux)
	server.mountRunUsageRoutes(mux)
	server.mountRunComparisonRoutes(mux)
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
	server.mountSsoRoutes(mux)
	server.mountBrowserSessionRoutes(mux)
	server.mountIdentityRoutes(mux)
	server.mountCausalRoutes(mux)
	if webdist.Enabled() {
		// Single-binary mode: the embedded Vite bundle rides the
		// mux's own catch-all — every unmatched GET serves static assets
		// or the SPA shell. Public by design (static content, no tenant
		// data); API patterns above always win by specificity.
		mux.Handle("GET /", webdist.Handler())
	}
	shutdown := func() {
		cancelServer()
		server.backgroundWG.Wait()
	}
	return WithBrowserHeaders(mux), shutdown
}

// runBackground owns fire-and-forget route work under the server lifetime.
// Request cancellation must not discard already-accepted feedback memory,
// while process shutdown still cancels and joins every outstanding task.
func (s *V1Server) runBackground(run func(context.Context)) {
	s.backgroundWG.Go(func() {
		run(s.background)
	})
}

type v1Request struct {
	orgID  string
	userID string
	id     string
	// authContext carries mode/source/role for audit + permissions.
	authContext *auth.Context
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, rc v1Request)

type identityRequest struct {
	userID   string
	id       string
	identity *auth.Identity
}

type identityHandlerFunc func(w http.ResponseWriter, r *http.Request, rc identityRequest)

func unsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead
}

func writeMiddlewareRejection(w http.ResponseWriter, r *http.Request, requestID string, rejection opResult) {
	if strings.HasPrefix(r.URL.Path, "/v1/") {
		writeVersioned(w, requestID, rejection)
	} else {
		writeUnversioned(w, rejection)
	}
}

func requireSessionCSRF(r *http.Request, mode auth.Mode) *opResult {
	if mode != auth.ModeJanuslySession || !unsafeMethod(r.Method) {
		return nil
	}
	if err := browsersession.RequireCSRF(r, isAllowedRequestOrigin); err != nil {
		rejection := opError(http.StatusForbidden, "server_request_failed", err.Error(), nil)
		return &rejection
	}
	return nil
}

// identity resolves only provider identity. It is intentionally incapable of
// producing an org scope and is restricted to the closed bootstrap registry.
func (s *V1Server) identity(next identityHandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestID := requestIDFrom(r)
		resolved, err := s.resolver.ResolveIdentity(r.Context(), r)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil))
			return
		}
		if resolved == nil {
			writeUnversioned(w, opError(http.StatusUnauthorized, "server_request_failed",
				"Unauthorized: missing or invalid identity provider", nil))
			return
		}
		if !identityOnlyRoutes[r.Pattern] {
			writeUnversioned(w, opError(http.StatusInternalServerError, "route_not_registered",
				"route "+r.Pattern+" is mounted with identity but is not identity-only", nil))
			return
		}
		if rejection := requireSessionCSRF(r, resolved.Mode); rejection != nil {
			writeMiddlewareRejection(w, r, requestID, *rejection)
			return
		}
		next(w, r, identityRequest{userID: resolved.UserID, id: requestID, identity: resolved})
	}
}

// optionalIdentity is the signed-out browser probe: provider errors remain
// visible, but a missing/invalid provider is passed to the handler as nil.
func (s *V1Server) optionalIdentity(next identityHandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestID := requestIDFrom(r)
		resolved, err := s.resolver.ResolveIdentity(r.Context(), r)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil))
			return
		}
		if !optionalIdentityRoutes[r.Pattern] {
			writeUnversioned(w, opError(http.StatusInternalServerError, "route_not_registered",
				"route "+r.Pattern+" is mounted with optional identity but is not registered", nil))
			return
		}
		next(w, r, identityRequest{userID: userIDOrEmpty(resolved), id: requestID, identity: resolved})
	}
}

func userIDOrEmpty(identity *auth.Identity) string {
	if identity == nil {
		return ""
	}
	return identity.UserID
}

// auth resolves provider identity through a real membership-authorized tenant
// context, then applies the closed role/permission registry.
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
			// The contract's 401: message and code from the dispatcher's
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
					writeUnversioned(w, *rejection)
				}
				return
			}
		} else if !authOnlyRoutes[r.Pattern] {
			// Fail CLOSED: an authenticated mount whose pattern is
			// in neither table is a missing registry entry, not a grant.
			rejection := opError(http.StatusInternalServerError, "route_not_registered",
				"route "+r.Pattern+" is mounted with auth but has no registry gate", nil)
			if strings.HasPrefix(r.URL.Path, "/v1/") {
				writeVersioned(w, rc.id, rejection)
			} else {
				writeUnversioned(w, rejection)
			}
			return
		}
		if rejection := requireSessionCSRF(r, resolved.Mode); rejection != nil {
			writeMiddlewareRejection(w, r, requestID, *rejection)
			return
		}
		next(w, r, rc)
	}
}
