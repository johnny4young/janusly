// Command mcp runs the pilot's MCP stdio server: a thin in-process layer
// over the engine (no HTTP hop) that lets an agent save workflows, start
// and inspect runs, and drive the dead-letter redrive loop. The process
// also runs the worker pool so runs progress with no other service up.
//
// Org scope comes from JANUSLY_GO_ORG (default "default") — the pilot's
// dev-auth analogue for a stdio transport.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/go/internal/boot"
	"github.com/johnny4young/janusly/go/internal/config"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/mcpserver"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	// Logs go to stderr — stdout belongs to the MCP transport.
	logger := boot.NewLogger()

	pool, err := boot.Connect(ctx, cfg.DatabaseURL, cfg.APIPoolSize+cfg.WorkerPoolSize)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := boot.ProbeMigrations(ctx, pool); err != nil {
		return err
	}

	eng := engine.New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	defer stopWorkers()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, cfg.WorkerConcurrency, cfg.PollInterval, dispatcher.Execute, logger)
	}()
	go eng.StartReaper(workerCtx, time.Minute, time.Hour, logger)
	defer func() { stopWorkers(); <-done }()

	org := os.Getenv("JANUSLY_GO_ORG")
	if org == "" {
		org = "default"
	}
	tracker := ratelimit.NewTracker(pool)
	server := mcpserver.NewServer(mcpserver.Deps{
		Engine: eng, Pool: pool, OrgID: org, UserID: "mcp", NewID: uuid.NewString,
		Limiter: ratelimit.New(pool, ratelimit.Hooks{
			OnError: tracker.RecordError, OnSuccess: tracker.RecordRecovery,
		}),
	})
	logger.Info("mcp server ready", "org", org, "startup", time.Now().UTC().Format(time.RFC3339))
	return server.Run(ctx, &mcp.StdioTransport{})
}
