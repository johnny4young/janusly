// Command api boots the pilot API: validated configuration, database pool,
// migration probe, and the public + internal HTTP servers, with a graceful
// shutdown that lets in-flight requests finish.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/boot"
	"github.com/johnny4young/janusly/go/internal/config"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/httpapi"
	"github.com/johnny4young/janusly/go/internal/migrate"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/upstream"
	"github.com/johnny4young/janusly/go/internal/usage"
)

const shutdownGrace = 10 * time.Second

func envDurationMs(name string, fallback time.Duration) time.Duration {
	if raw := os.Getenv(name); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return fallback
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

	cfg, err := config.Load(nil)
	if err != nil {
		return err
	}
	logger := boot.NewLogger()

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
	workerPool, err := boot.Connect(ctx, cfg.DatabaseURL, cfg.WorkerPoolSize)
	if err != nil {
		return err
	}
	defer workerPool.Close()
	if err := boot.ProbeMigrations(ctx, pool); err != nil {
		return err
	}
	// Process-global LLM telemetry recorder (the reference's
	// setUsageRecorder(recordUsage) boot step) — registered before any
	// surface that could fire an LLM call.
	usage.SetRecorder(usage.NewDBRecorder(pool))
	logger.Info("boot", "port", cfg.Port, "internal_port", cfg.InternalPort)

	// The pilot ships as one binary: the API process also runs the worker
	// pool. The processes split when scale demands it — the engine already
	// supports N independent consumers.
	eng := engine.New(workerPool)
	prometheus.MustRegister(engine.NewQueueDepthCollector(pool))
	// Reference-name parity series so existing dashboards need no rename,
	// plus the OTel Resource rendered the Prometheus way: a target_info
	// gauge carrying service name/namespace/instance.
	prometheus.MustRegister(engine.NewQueueParityCollector(pool))
	prometheus.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "janusly_rate_limit_degraded_buckets",
		Help: "Rate-limiter buckets currently failing open in this process.",
	}, ratelimit.DegradedBucketCount))
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
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	// Every background loop runs SUPERVISED (T-512): named start, panic →
	// recover + log + backoff restart (a sweep bug never takes the API
	// down), and one deterministic drain on shutdown BEFORE pools close.
	runner := boot.NewRunner(context.Background(), logger)
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
	defer runner.Shutdown()

	api := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           httpapi.NewV1Handler(eng, pool),
		ReadHeaderTimeout: 10 * time.Second,
	}
	internal := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", cfg.InternalPort),
		Handler:           httpapi.NewInternalHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

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
