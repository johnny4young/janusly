// Command api boots the pilot API: validated configuration, database pool,
// migration probe, and the public + internal HTTP servers, with a graceful
// shutdown that lets in-flight requests finish.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/boot"
	"github.com/johnny4young/janusly/go/internal/buildinfo"
	"github.com/johnny4young/janusly/go/internal/config"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/httpapi"
	"github.com/johnny4young/janusly/go/internal/migrate"
	"github.com/johnny4young/janusly/go/internal/observability"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/upstream"
	"github.com/johnny4young/janusly/go/internal/usage"
)

const (
	shutdownGrace           = 10 * time.Second
	serverReadHeaderTimeout = 10 * time.Second
	serverReadTimeout       = 30 * time.Second
	serverIdleTimeout       = 2 * time.Minute
	serverMaxHeaderBytes    = 64 << 10
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
		return errors.New("ALLOW_DEV_SSO_BYPASS must not be set when JANUSLY_GO_ENV=production")
	}
	return nil
}

func requireSigningSecret(production bool) error {
	if !production {
		return nil
	}
	if strings.TrimSpace(os.Getenv("JANUSLY_RESUME_TOKEN_SECRET")) == "" {
		return errors.New("JANUSLY_RESUME_TOKEN_SECRET is required when JANUSLY_GO_ENV=production")
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
	// silent via "none" (reference otel.ts posture). Shutdown flushes the
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

	// Single-binary ops: `janusly-go migrate` applies the embedded goose
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
		slog.Info("credential root key not configured; managed secrets disabled (legacy env refs only)")
	}
	// The reference's production fail-fast: without Supabase configured,
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
	enginePool := pool
	if cfg.WorkPlaneEnabled {
		workerPool, err := boot.Connect(ctx, cfg.DatabaseURL, cfg.WorkerPoolSize)
		if err != nil {
			return err
		}
		defer workerPool.Close()
		enginePool = workerPool
	}
	if err := boot.ProbeMigrations(ctx, pool); err != nil {
		return err
	}
	// Process-global LLM telemetry recorder (the reference's
	// setUsageRecorder(recordUsage) boot step) — registered before any
	// surface that could fire an LLM call.
	usage.SetRecorder(usage.NewDBRecorder(pool))
	workPlaneMode := "passive"
	if cfg.WorkPlaneEnabled {
		workPlaneMode = "active"
	}
	logger.Info("boot", "port", cfg.Port, "internal_host", cfg.InternalHost,
		"internal_port", cfg.InternalPort, "work_plane", workPlaneMode,
		"build_verified", identity.Verified, "build_commit", identity.Commit,
		"build_tree", identity.Tree, "artifact_sha256", identity.ArtifactSHA256)

	// The pilot ships as one binary: the API process also runs the worker
	// pool. The processes split when scale demands it — the engine already
	// supports N independent consumers.
	eng := engine.New(enginePool)
	prometheus.MustRegister(engine.NewQueueDepthCollector(pool))
	// Reference-name parity series so existing dashboards need no rename,
	// plus the OTel Resource rendered the Prometheus way: a target_info
	// gauge carrying service name/namespace/instance.
	prometheus.MustRegister(engine.NewQueueParityCollector(pool))
	prometheus.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "janusly_rate_limit_degraded_buckets",
		Help: "Rate-limiter buckets currently failing open in this process.",
	}, ratelimit.DegradedBucketCount))
	// Maintenance runs as supervised in-process loops in the Go binary. The
	// reference names stay present with an always-drained value so dashboards
	// and certification can distinguish a clear lane from missing telemetry.
	for _, metric := range []struct{ name, help string }{
		{"maintenance_queue_waiting_jobs", "Maintenance jobs awaiting the in-process work plane."},
		{"maintenance_queue_active_jobs", "Maintenance jobs active in the in-process work plane."},
	} {
		prometheus.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: metric.name, Help: metric.help,
		}, func() float64 { return 0 }))
	}
	resourceInfo := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "target_info",
		Help: "OTel Resource identity for this process.",
		ConstLabels: prometheus.Labels{
			"service_name": "janusly", "service_namespace": "janusly",
			"service_instance_id": resourceInstanceID(),
		},
	})
	resourceInfo.Set(1)
	prometheus.MustRegister(resourceInfo)
	prometheus.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "janusly_go_work_plane_active",
		Help: "Whether this process owns PostgreSQL claims and background mutation loops.",
	}, func() float64 {
		if cfg.WorkPlaneEnabled {
			return 1
		}
		return 0
	}))
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	// Every background loop runs SUPERVISED: named start, panic →
	// recover + log + backoff restart (a sweep bug never takes the API
	// down), and one deterministic drain on shutdown BEFORE pools close.
	runner := boot.NewRunner(context.Background(), logger)
	if cfg.WorkPlaneEnabled {
		runner.Go("workers", func(ctx context.Context) {
			_ = eng.RunWorkers(ctx, cfg.WorkerConcurrency, cfg.PollInterval, dispatcher.Execute, logger)
		})
		runner.Go("replay-campaign-pump", func(ctx context.Context) {
			eng.RunReplayCampaignPump(ctx, cfg.PollInterval, logger)
		})
		runner.Go("retention", func(ctx context.Context) {
			eng.RunRetentionSweep(ctx, time.Hour, engine.RetentionDays(), logger)
		})
		runner.Go("upstream-health", func(ctx context.Context) {
			upstream.RunSweep(ctx, pool, time.Minute, logger)
		})
		runner.Go("subworkflow-terminal-reconciler", func(ctx context.Context) {
			eng.RunSubworkflowTerminalReconciler(ctx, time.Minute, logger)
		})
		runner.Go("schedule-sweep", func(ctx context.Context) {
			eng.RunScheduleSweep(ctx, 15*time.Second, logger)
		})
		runner.Go("auto-healing", func(ctx context.Context) {
			eng.RunAutoHealingSweep(ctx, 5*time.Minute, logger)
		})
		runner.Go("memory-consent-purge", func(ctx context.Context) {
			eng.RunMemoryConsentPurgeSweep(ctx, time.Hour, logger)
		})
		// Reaper cadence/threshold are env-tunable for HA deployments (and the
		// kill-failover harness): a two-replica setup wants a threshold near
		// its longest legitimate node runtime, not the conservative 1h default.
		runner.Go("stalled-node-reaper", func(ctx context.Context) {
			eng.StartReaper(ctx,
				envDurationMs("JANUSLY_GO_REAPER_INTERVAL_MS", time.Minute),
				envDurationMs("JANUSLY_GO_REAPER_THRESHOLD_MS", time.Hour), logger)
		})
	} else {
		logger.Warn("work plane passive; background claims and mutations are disabled")
	}
	defer runner.Shutdown()

	publicAPI, shutdownPublicAPI := httpapi.NewV1HandlerWithShutdown(eng, pool)
	defer shutdownPublicAPI()
	publicHandler := httpapi.WithWorkPlaneGate(publicAPI, cfg.WorkPlaneEnabled)
	api := newHTTPServer(fmt.Sprintf(":%d", cfg.Port), publicHandler)
	internal := newHTTPServer(
		fmt.Sprintf("%s:%d", cfg.InternalHost, cfg.InternalPort),
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
	return errors.Join(problems...)
}

// resourceInstanceID resolves the per-process identity like the
// reference's Resource: explicit env, then HOSTNAME, then the OS.
func resourceInstanceID() string {
	if id := os.Getenv("OTEL_SERVICE_INSTANCE_ID"); id != "" {
		return id
	}
	if id := os.Getenv("HOSTNAME"); id != "" {
		return id
	}
	host, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return host
}
