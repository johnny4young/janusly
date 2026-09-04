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
	"fmt"
	"log/slog"
	"net/http"
	"strings"
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

type readinessProbe func(context.Context) error

const readinessTimeout = time.Second

func writeOperationalStatus(w http.ResponseWriter, status int, ok bool) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if ok {
		_, _ = w.Write([]byte(`{"ok":true}`))
		return
	}
	_, _ = w.Write([]byte(`{"ok":false}`))
}

func healthzHandler(w http.ResponseWriter, _ *http.Request) {
	writeOperationalStatus(w, http.StatusOK, true)
}

func readyzHandler(timeout time.Duration, probe readinessProbe) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if probe == nil {
			writeOperationalStatus(w, http.StatusServiceUnavailable, false)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		if err := probe(ctx); err != nil {
			writeOperationalStatus(w, http.StatusServiceUnavailable, false)
			return
		}
		writeOperationalStatus(w, http.StatusOK, true)
	}
}

// V1Server owns the /v1 route surface over one engine and pool.
type V1Server struct {
	engine         *engine.Engine
	pool           *pgxpool.Pool
	newID          func() string
	hub            *streamHub
	routeAuthz     map[string]routeGate
	startRunLimit  ratelimit.Options
	statusPages    statusPageCache
	resolver       *auth.Resolver
	authPolicy     *authpolicy.Evaluator
	limiter        *ratelimit.Limiter
	limiterTracker *ratelimit.Tracker
	queueCache     *queueHealthCache
	mcp            *mcpclient.Client
	workos         workosClient
	feedbackMemory *feedbackMemoryPool
}

// V1ServerOptions describes process-owned feedback-memory work. Validation is
// repeated at the HTTP construction boundary so tests and future embedders
// cannot accidentally bypass the bounded runtime configuration.
type V1ServerOptions struct {
	FeedbackMemoryWorkers       int
	FeedbackMemoryQueueCapacity int
	FeedbackMemoryTaskTimeout   time.Duration
	Logger                      *slog.Logger
	// Supervise runs a named background loop under the process's sweep
	// group, so the stream hub restarts on panic and drains before pools
	// close like every other loop. nil (tests, ad-hoc handlers) falls back
	// to an owned goroutine that shutdown joins.
	Supervise func(name string, fn func(ctx context.Context))
	// StartRateLimitPerMinute bounds POST /v1/start per organization; 0
	// resolves JANUSLY_START_RATE_LIMIT_PER_MIN or the default.
	StartRateLimitPerMinute int
}

// DefaultV1ServerOptions returns the production-safe bounded defaults.
func DefaultV1ServerOptions() V1ServerOptions {
	return V1ServerOptions{
		FeedbackMemoryWorkers:       defaultFeedbackMemoryWorkers,
		FeedbackMemoryQueueCapacity: defaultFeedbackMemoryQueueCapacity,
		FeedbackMemoryTaskTimeout:   defaultFeedbackMemoryTaskTimeout,
		Logger:                      slog.Default(),
		StartRateLimitPerMinute:     startRateLimitFromEnv(),
	}
}

// NewV1Handler mounts the v1 routes plus the operational health surfaces. The stream hub's
// LISTEN connection lives for the process (the production shape).
func NewV1Handler(eng *engine.Engine, pool *pgxpool.Pool) http.Handler {
	handler, _ := NewV1HandlerWithShutdown(eng, pool)
	return handler
}

// NewV1HandlerWithShutdown additionally returns a compatibility shutdown func
// that cancels the stream hub's hijacked LISTEN connection and drains optional
// feedback-memory work. Test harnesses MUST call it before closing the pool.
func NewV1HandlerWithShutdown(eng *engine.Engine, pool *pgxpool.Pool) (http.Handler, func()) {
	options := DefaultV1ServerOptions()
	handler, shutdown, err := newV1HandlerWithWorkOS(eng, pool, workos.NewFromEnv(), options)
	if err != nil {
		options.Logger.Error("V1 server construction failed", "reason", "feedback_memory_options")
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		}), func() {}
	}
	return handler, func() {
		ctx, cancel := context.WithTimeout(context.Background(), feedbackMemoryTaskTimeoutMax)
		defer cancel()
		if err := shutdown(ctx); err != nil {
			options.Logger.Error("V1 server shutdown incomplete", "reason", "feedback_memory_drain")
		}
	}
}

// NewV1HandlerWithOptions builds the production surface with explicitly
// validated background-work bounds. Shutdown must run before either database
// pool closes because accepted tasks retain the API pool.
func NewV1HandlerWithOptions(
	eng *engine.Engine,
	pool *pgxpool.Pool,
	options V1ServerOptions,
) (http.Handler, func(context.Context) error, error) {
	return newV1HandlerWithWorkOS(eng, pool, workos.NewFromEnv(), options)
}

func newV1HandlerWithWorkOS(
	eng *engine.Engine,
	pool *pgxpool.Pool,
	client workosClient,
	options V1ServerOptions,
) (http.Handler, func(context.Context) error, error) {
	feedbackMemory, err := newFeedbackMemoryPool(feedbackMemoryPoolOptions{
		workers:       options.FeedbackMemoryWorkers,
		queueCapacity: options.FeedbackMemoryQueueCapacity,
		taskTimeout:   options.FeedbackMemoryTaskTimeout,
		logger:        options.Logger,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("feedback memory pool options: %w", err)
	}
	serverCtx, cancelServer := context.WithCancel(context.Background())
	server := &V1Server{
		engine: eng, pool: pool, resolver: auth.NewResolver(pool, auth.ConfigFromEnv()),
		newID: uuid.NewString, hub: newStreamHub(), workos: client, feedbackMemory: feedbackMemory,
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
	// The hub reconnects on connection loss itself; supervision is what turns
	// a panic into a logged restart instead of a silent degradation to the
	// poll fallback, and what makes shutdown wait for the hijacked LISTEN
	// connection to be released before the pool closes.
	runHub := func(ctx context.Context) {
		for ctx.Err() == nil && serverCtx.Err() == nil {
			server.hub.listen(ctx, pool)
			select {
			case <-time.After(time.Second):
			case <-ctx.Done():
				return
			case <-serverCtx.Done():
				return
			}
		}
	}
	hubDone := make(chan struct{})
	hubLogger := options.Logger
	if options.Supervise != nil {
		close(hubDone)
		options.Supervise("stream-hub", runHub)
	} else {
		go func() {
			defer close(hubDone)
			defer func() {
				if cause := recover(); cause != nil && hubLogger != nil {
					hubLogger.Error("stream hub panic recovered", "panic", cause)
				}
			}()
			runHub(serverCtx)
		}()
	}
	server.routeAuthz = newRouteAuthz()
	server.startRunLimit = startRateLimit(options.StartRateLimitPerMinute)
	mux := http.NewServeMux()
	server.mountAPIRoutes(mux)

	// The embedded Vite bundle rides the mux's own catch-all: every unmatched
	// GET serves a static asset or the SPA shell. API patterns above always win
	// by specificity, and static content is public by design.
	mux.Handle("GET /", webdist.Handler())
	shutdown := func(ctx context.Context) error {
		cancelServer()
		// Join the unsupervised hub (supervised ones drain with the runner).
		select {
		case <-hubDone:
		case <-ctx.Done():
			return fmt.Errorf("stream hub did not stop before shutdown deadline: %w", ctx.Err())
		}
		return server.feedbackMemory.shutdown(ctx)
	}
	// Browser headers resolve the request id first; the telemetry wrapper
	// inside them records metrics, one server span and the access log line.
	return WithBrowserHeaders(withRequestTelemetry(mux, options.Logger)), shutdown, nil
}

// mountAPIRoutes registers every API pattern without the SPA catch-all.
// Tests can therefore ask the real ServeMux whether a browser call resolves;
// the production handler mounts the static catch-all only after this method.
func (s *V1Server) mountAPIRoutes(mux *http.ServeMux) {
	// Every mount owns its table: the constructor seeds it, and a bare
	// server built by a test gets the same base rather than a nil-map panic.
	if s.routeAuthz == nil {
		s.routeAuthz = newRouteAuthz()
	}
	mux.HandleFunc("GET /healthz", healthzHandler)
	mux.HandleFunc("GET /readyz", readyzHandler(readinessTimeout, s.pool.Ping))
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
			"rateLimiter": s.limiterTracker.Public(),
			"queue":       s.publicQueueHealth(ctx),
		})
		_, _ = w.Write(payload)
	})
	// Org-config read: the full closed catalog with layered effective
	// values (tenant row → env → default) and provenance per key.
	mux.HandleFunc("GET /org/config", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.listOrgConfigCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/workflows/save", s.auth(s.saveWorkflow))
	mux.HandleFunc("POST /v1/workflows/rollback", s.auth(s.rollbackWorkflow))
	mux.HandleFunc("POST /v1/workflows/readiness", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/readiness", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/validate", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.validateCore(r, rc))
	}))
	mux.HandleFunc("POST /validate", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.validateCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/{id}/resume", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.resumeWorkflowCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("POST /v1/workflows/{id}/resume", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.resumeWorkflowCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("GET /v1/workflows", s.auth(s.listWorkflows))
	mux.HandleFunc("GET /v1/workflows/latest", s.auth(s.latestWorkflowVersion))
	mux.HandleFunc("GET /v1/workflows/versions", s.auth(s.listWorkflowVersions))
	mux.HandleFunc("GET /v1/workflows/versions/{versionId}", s.auth(s.workflowVersionSnapshot))
	mux.HandleFunc("POST /v1/start", s.auth(s.startRun))
	mux.HandleFunc("POST /triggers/webhook/ingest", s.auth(s.ingestWebhookBySelector))
	mux.HandleFunc("POST /v1/webhooks/{workflowId}", s.auth(s.ingestWebhook))
	mux.HandleFunc("POST /v1/triggers/email/ingest", s.auth(s.ingestEmail))
	mux.HandleFunc("POST /v1/triggers/file/ingest", s.auth(s.ingestFileDropped))
	mux.HandleFunc("POST /v1/triggers/mcp/ingest", s.auth(s.ingestMcpEvent))
	mux.HandleFunc("GET /v1/run", s.auth(s.getRun))
	mux.HandleFunc("GET /v1/status", s.auth(s.getRun))
	mux.HandleFunc("GET /v1/runs", s.auth(s.listRuns))
	mux.HandleFunc("POST /v1/resume", s.auth(s.resumeRun))
	mux.HandleFunc("POST /v1/run/cancel", s.auth(s.cancelRun))
	mux.HandleFunc("GET /v1/dlq", s.auth(s.listDeadLetters))
	mux.HandleFunc("POST /runs/redrive", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.runsRedriveCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/runs/redrive", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.runsRedriveCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/recovery/metrics", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryMetricsCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/metrics", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryMetricsCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/dlq/clusters", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.clustersCore(r, rc))
	}))
	mux.HandleFunc("GET /dlq/clusters", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.clustersCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/dlq/redrive", s.auth(s.redrive))
	mux.HandleFunc("POST /v1/dlq/replay", s.auth(s.replayAlias))
	mux.HandleFunc("GET /runs/{runId}/stream", s.auth(s.streamRun))
	mux.HandleFunc("GET /auth/context", s.identity(s.authContext))
	// The AI Studio's tool catalog; the web calls it through /v1.
	mux.HandleFunc("GET /v1/tools", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeV1Data(w, rc.id, executors.SharedToolRegistry().Catalog())
	}))
	mux.HandleFunc("GET /tools", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(executors.SharedToolRegistry().Catalog())
	}))
	s.unversionedRoutes(mux)
	s.mountCampaignRoutes(mux)
	s.mountMemberRoutes(mux)
	s.mountRoleRoutes(mux)
	s.mountAuditRoutes(mux)
	s.mountOrgConfigRoutes(mux)
	s.mountRunUsageRoutes(mux)
	s.mountRunComparisonRoutes(mux)
	s.mountSystemHealthRoutes(mux)
	s.mountAiGenerateRoutes(mux)
	s.mountAuthoringRoutes(mux)
	s.mountOperationsRoutes(mux)
	s.mountPromptRoutes(mux)
	s.mountMcpRoutes(mux)
	s.mountValidateFixRoutes(mux)
	s.mountPlaybookRoutes(mux)
	s.mountDrillRoutes(mux)
	s.mountFeedbackRoutes(mux)
	s.mountRecoveryItemRoutes(mux)
	s.mountRecoveryQueueRoutes(mux)
	s.mountBulkRecoveryRoutes(mux)
	s.mountRecoveryHomeRoutes(mux)
	s.mountAlertRoutes(mux)
	s.mountReportRoutes(mux)
	s.mountRolloutRoutes(mux)
	s.mountCredentialRoutes(mux)
	s.mountSlackInteractionRoutes(mux)
	s.mountExternalRuntimeRoutes(mux)
	s.mountUpstreamHealthRoutes(mux)
	s.mountAutoHealingRoutes(mux)
	s.mountProductSurfaceRoutes(mux)
	s.mountWorkflowHealthRoutes(mux)
	s.mountWorkflowMetadataRoutes(mux)
	s.mountInputPresetRoutes(mux)
	s.mountEvalRoutes(mux)
	s.mountScimRoutes(mux)
	s.mountF1SweepRoutes(mux)
	s.mountRunSearchRoutes(mux)
	s.mountStatusPageRoutes(mux)
	s.mountAiPatchRoutes(mux)
	s.mountAiSurfaceRoutes(mux)
	s.mountBillingRoutes(mux)
	s.mountReplayLabRoutes(mux)
	s.mountRecoveryReadRoutes(mux)
	s.mountSemanticRecoveryRoutes(mux)
	s.mountSsoRoutes(mux)
	s.mountBrowserSessionRoutes(mux)
	s.mountIdentityRoutes(mux)
	s.mountCausalRoutes(mux)
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
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
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
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
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
		markRoutePattern(r)
		requestID := requestIDFrom(r)
		resolved, err := s.resolver.Resolve(r.Context(), r)
		if err != nil {
			writeV1Error(w, requestID, http.StatusInternalServerError, "internal_error",
				"Internal error", nil)
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
		if gate, gatedRoute := s.routeAuthz[r.Pattern]; gatedRoute {
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
