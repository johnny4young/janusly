// Command api boots the pilot API: validated configuration, database pool,
// migration probe, and the public + internal HTTP servers, with a graceful
// shutdown that lets in-flight requests finish.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/johnny4young/janusly/go/internal/boot"
	"github.com/johnny4young/janusly/go/internal/config"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/httpapi"
)

const shutdownGrace = 10 * time.Second

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
	logger.Info("boot", "port", cfg.Port, "internal_port", cfg.InternalPort)

	// The pilot ships as one binary: the API process also runs the worker
	// pool. The processes split when scale demands it — the engine already
	// supports N independent consumers.
	eng := engine.New(workerPool)
	prometheus.MustRegister(engine.NewQueueDepthCollector(pool))
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	defer stopWorkers()
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		_ = eng.RunWorkers(workerCtx, cfg.WorkerConcurrency, cfg.PollInterval, dispatcher.Execute, logger)
	}()
	go func() {
		eng.RunReplayCampaignPump(workerCtx, cfg.PollInterval, logger)
	}()
	go func() {
		eng.RunRetentionSweep(workerCtx, time.Hour, engine.RetentionDays(), logger)
	}()
	go eng.StartReaper(workerCtx, time.Minute, time.Hour, logger)
	defer func() { stopWorkers(); <-workersDone }()

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
