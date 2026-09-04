// Command api boots Janusly: validated configuration, database pools,
// migration probe, and the public + internal HTTP servers, with a graceful
// shutdown that lets in-flight requests finish.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/boot"
	"github.com/johnny4young/janusly/internal/buildinfo"
	"github.com/johnny4young/janusly/internal/config"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/httpapi"
	"github.com/johnny4young/janusly/internal/migrate"
	"github.com/johnny4young/janusly/internal/observability"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/upstream"
	"github.com/johnny4young/janusly/internal/usage"
)

const (
	shutdownGrace            = 10 * time.Second
	feedbackMemoryDrainGrace = 5 * time.Minute
	serverReadHeaderTimeout  = 10 * time.Second
	serverReadTimeout        = 30 * time.Second
	serverIdleTimeout        = 2 * time.Minute
	serverMaxHeaderBytes     = 64 << 10
)

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: serverReadHeaderTimeout,
		ReadTimeout:       serverReadTimeout,
		IdleTimeout:       serverIdleTimeout,
		MaxHeaderBytes:    serverMaxHeaderBytes,
		// A process-wide WriteTimeout would terminate long-lived run SSE
		// streams. Non-streaming handlers own bounded contexts instead.
	}
}

func envDurationMs(name string, fallback time.Duration) time.Duration {
	if raw := os.Getenv(name); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return fallback
}

// requireSigningSecret fails STARTUP when a production deployment has no
// dedicated token-signing secret. Without it the signer falls back to a
// constant that ships in the source tree, and the failure only surfaced
// lazily at the first token operation — long after the process began
// serving traffic. Same posture as the provenance gate above: refuse to
// start rather than run in an unverifiable configuration.
// refuseDevBypassInProduction stops a production boot when the SSO
// development escape hatch is set. It disables enforced SSO for real
// provider identities, so a value carried over from a staging
// environment would silently void an organization's SSO requirement for
// as long as the process runs. Loud at startup beats invisible at
// runtime; the evaluator ignores it in production regardless.
func refuseDevBypassInProduction(production bool) error {
	if production && os.Getenv("ALLOW_DEV_SSO_BYPASS") == "true" {
		return errors.New("ALLOW_DEV_SSO_BYPASS must not be set when JANUSLY_ENV=production")
	}
	return nil
}

func requireSigningSecret(production bool) error {
	if !production {
		return nil
	}
	if strings.TrimSpace(os.Getenv("JANUSLY_RESUME_TOKEN_SECRET")) == "" {
		return errors.New("JANUSLY_RESUME_TOKEN_SECRET is required when JANUSLY_ENV=production")
	}
	return nil
}

func requireBuildProvenance(production bool, identity buildinfo.Identity) error {
	if !production {
		return nil
	}
	if err := identity.Validate(); err != nil {
		return fmt.Errorf("production requires verified build provenance: %w", err)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	identity, err := buildinfo.Current()
	if err != nil {
		return err
	}
	// The provenance command is deliberately database- and configuration-free:
	// CI verifies the finished bytes before publishing them, and operators can
	// inspect an artifact without granting it runtime credentials.
	if len(os.Args) > 1 && os.Args[1] == "provenance" {
		if err := identity.Validate(); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(identity)
	}

	cfg, err := config.Load(nil)
	if err != nil {
		return err
	}
	// `janusly readyz` probes the serving process on the configured port so
	// the distroless image (no shell, no curl) can run its own healthcheck.
	if len(os.Args) > 1 && os.Args[1] == "readyz" {
		return probeReadiness(cfg.Port)
	}
	if err := requireBuildProvenance(cfg.Production, identity); err != nil {
		return err
	}
	if err := requireSigningSecret(cfg.Production); err != nil {
		return err
	}
	if err := refuseDevBypassInProduction(cfg.Production); err != nil {
		return err
	}
	logger := boot.NewLogger()

	// Traces: console exporter by default, OTLP/HTTP via OTEL_EXPORTER=otlp,
	// silent via "none". Shutdown flushes the
	// batch queue so the last spans are not dropped on SIGTERM.
	traceShutdown, err := observability.InitTracing(ctx)
	if err != nil {
		return err
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = traceShutdown(flushCtx)
	}()

	// Single-binary ops: `janusly migrate` applies the embedded goose
	// migrations and exits; the serving path refuses a stale schema.
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := migrate.Up(ctx, cfg.DatabaseURL); err != nil {
			return err
		}
		logger.Info("migrations applied")
		return nil
	}
	if err := migrate.AssertMigrated(ctx, cfg.DatabaseURL); err != nil {
		return err
	}
	// Secret Store boot probe: a malformed root key fails fast at deploy
	// time, not as the first credential write's 500. Unset stays legal
	// (legacy environment references only).
	if configured, err := secretstore.AssertCredentialRootKeyUsable(); err != nil {
		return err
	} else if !configured {
		slog.Info("credential root key not configured; managed secrets disabled (environment refs only)")
	}
	// Without Supabase configured,
	// production refuses to start unless dev headers are explicitly
	// allowed — never a silent anonymous fallback.
	if err := auth.ConfigFromEnv().BootError(); err != nil {
		return err
	}

	// Two pools, one truth from the load tests: API pollers and worker
	// transactions must not compete for the same connection budget.
	pool, err := boot.Connect(ctx, cfg.DatabaseURL, cfg.APIPoolSize)
	if err != nil {
		return err
	}
	defer pool.Close()
	workerPool, err := boot.Connect(ctx, cfg.DatabaseURL, cfg.WorkerPoolSize)
	if err != nil {
		return err
	}
	defer workerPool.Close()
	if err := boot.ProbeMigrations(ctx, pool); err != nil {
		return err
	}
	// Process-global LLM telemetry recorder, registered before any
	// surface that could fire an LLM call.
	usage.SetRecorder(usage.NewDBRecorder(pool))
	logger.Info("boot", "port", cfg.Port, "internal_host", cfg.InternalHost,
		"internal_port", cfg.InternalPort,
		"build_verified", identity.Verified, "build_commit", identity.Commit,
		"build_tree", identity.Tree, "artifact_sha256", identity.ArtifactSHA256)

	// Janusly ships as one binary: the API process also runs the worker
	// pool. The processes split when scale demands it — the engine already
	// supports N independent consumers.
	eng := engine.New(workerPool)
	prometheus.MustRegister(engine.NewQueueDepthCollector(pool))
	// Stable workflow queue series plus the OTel Resource rendered the
	// Prometheus way: a target_info
	// gauge carrying service name/namespace/instance.
	prometheus.MustRegister(engine.NewWorkflowQueueCollector(pool))
	prometheus.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "janusly_rate_limit_degraded_buckets",
		Help: "Rate-limiter buckets currently failing open in this process.",
	}, ratelimit.DegradedBucketCount))
	instanceID := resourceInstanceID()
	resourceInfo := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "target_info",
		Help: "OTel Resource identity for this process.",
		ConstLabels: prometheus.Labels{
			"service_name": "janusly", "service_namespace": "janusly",
			"service_instance_id": instanceID,
		},
	})
	resourceInfo.Set(1)
	prometheus.MustRegister(resourceInfo)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	// Every background loop runs SUPERVISED: named start, panic →
	// recover + log + backoff restart (a sweep bug never takes the API
	// down), and one deterministic drain on shutdown BEFORE pools close.
	runner := boot.NewRunner(context.Background(), logger)
	runner.Go("workers", func(ctx context.Context) {
		_ = eng.RunWorkers(ctx, cfg.WorkerConcurrency, cfg.PollInterval, dispatcher.Execute, logger)
	})
	runner.Go("worker-heartbeat", func(ctx context.Context) {
		eng.RunWorkerHeartbeat(ctx, instanceID, cfg.WorkerConcurrency, identity.Commit, logger)
	})
	runner.Go(observability.SweepReplayCampaignPump, func(ctx context.Context) {
		eng.RunReplayCampaignPump(ctx, cfg.PollInterval, logger)
	})
	runner.Go(observability.SweepRetention, func(ctx context.Context) {
		eng.RunRetentionSweep(ctx, time.Hour, engine.RetentionDays(), logger)
	})
	runner.Go(observability.SweepUpstreamHealth, func(ctx context.Context) {
		upstream.RunSweep(ctx, pool, time.Minute, logger)
	})
	runner.Go(observability.SweepSubworkflowReconciler, func(ctx context.Context) {
		eng.RunSubworkflowTerminalReconciler(ctx, time.Minute, logger)
	})
	runner.Go(observability.SweepSchedule, func(ctx context.Context) {
		eng.RunScheduleSweep(ctx, 15*time.Second, logger)
	})
	runner.Go(observability.SweepAutoHealing, func(ctx context.Context) {
		eng.RunAutoHealingSweep(ctx, 5*time.Minute, logger)
	})
	runner.Go(observability.SweepMemoryConsentPurge, func(ctx context.Context) {
		eng.RunMemoryConsentPurgeSweep(ctx, time.Hour, logger)
	})
	runner.Go(observability.SweepRunSummaryMemory, func(ctx context.Context) {
		eng.RunRunSummaryMemorySweep(ctx, time.Second, logger)
	})
	// Reaper cadence/threshold are env-tunable for HA deployments.
	runner.Go(observability.SweepStalledNodeReaper, func(ctx context.Context) {
		eng.StartReaper(ctx,
			envDurationMs("JANUSLY_REAPER_INTERVAL_MS", time.Minute),
			envDurationMs("JANUSLY_REAPER_THRESHOLD_MS", time.Hour), logger)
	})
	defer runner.Shutdown()

	publicAPI, shutdownPublicAPI, err := httpapi.NewV1HandlerWithOptions(eng, pool, httpapi.V1ServerOptions{
		FeedbackMemoryWorkers:       cfg.FeedbackMemoryWorkers,
		FeedbackMemoryQueueCapacity: cfg.FeedbackMemoryQueueCapacity,
		FeedbackMemoryTaskTimeout:   cfg.FeedbackMemoryTaskTimeout,
		Logger:                      logger,
		Supervise:                   runner.Go,
	})
	if err != nil {
		return err
	}
	defer func() {
		drainCtx, cancelDrain := context.WithTimeout(context.Background(), feedbackMemoryDrainGrace)
		defer cancelDrain()
		if err := shutdownPublicAPI(drainCtx); err != nil {
			logger.Error("V1 server shutdown incomplete", "reason", "feedback_memory_drain")
		}
	}()
	api := newHTTPServer(fmt.Sprintf(":%d", cfg.Port), publicAPI)
	internal := newHTTPServer(
		net.JoinHostPort(cfg.InternalHost, strconv.Itoa(cfg.InternalPort)),
		httpapi.NewInternalHandler(identity),
	)

	failures := make(chan error, 2)
	for _, srv := range []*http.Server{api, internal} {
		go func() {
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				failures <- fmt.Errorf("%s: %w", srv.Addr, err)
			}
		}()
	}

	select {
	case err := <-failures:
		return err
	case <-ctx.Done():
	}

	logger.Info("shutdown", "grace", shutdownGrace.String())
	graceCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	var problems []error
	for _, srv := range []*http.Server{api, internal} {
		if err := srv.Shutdown(graceCtx); err != nil {
			problems = append(problems, err)
		}
	}
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), feedbackMemoryDrainGrace)
	defer cancelDrain()
	if err := shutdownPublicAPI(drainCtx); err != nil {
		problems = append(problems, err)
	}
	return errors.Join(problems...)
}

// resourceInstanceID resolves one boot identity. An explicit OTel instance ID
// is already required to be process-unique; automatic host/container fallbacks
// append a UUID so an immediate restart cannot inherit stale started/build
// metadata from a previous process on the same host.
func resourceInstanceID() string {
	if id := os.Getenv("OTEL_SERVICE_INSTANCE_ID"); id != "" {
		return id
	}
	base := os.Getenv("HOSTNAME")
	if base == "" {
		base, _ = os.Hostname()
	}
	if base == "" {
		base = "janusly"
	}
	return base + "-" + uuid.NewString()
}

const readinessProbeTimeout = 3 * time.Second

func probeReadiness(port int) error {
	ctx, cancel := context.WithTimeout(context.Background(), readinessProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/readyz", port), nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("readyz: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("readyz: %s", res.Status)
	}
	return nil
}
