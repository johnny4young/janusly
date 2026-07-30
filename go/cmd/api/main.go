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

	"github.com/johnny4young/janusly/go/internal/boot"
	"github.com/johnny4young/janusly/go/internal/config"
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

	pool, err := boot.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := boot.ProbeMigrations(ctx, pool); err != nil {
		return err
	}
	logger.Info("boot", "port", cfg.Port, "internal_port", cfg.InternalPort)

	api := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           httpapi.NewAPIHandler(),
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
