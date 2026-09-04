// Command mcp runs Janusly's MCP stdio server: a thin in-process layer
// over the engine (no HTTP hop) that lets an agent save workflows, start
// and inspect runs, and drive the dead-letter redrive loop. The process
// also runs the worker pool so runs progress with no other service up.
//
// Org scope comes from JANUSLY_ORG (default "default") — the local
// dev-auth analogue for a stdio transport.
package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/boot"
	"github.com/johnny4young/janusly/internal/config"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/mcpserver"
	"github.com/johnny4young/janusly/internal/migrate"
	"github.com/johnny4young/janusly/internal/ratelimit"
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

	if err := migrate.AssertMigrated(ctx, cfg.DatabaseURL); err != nil {
		return err
	}
	pool, err := boot.Connect(ctx, cfg.DatabaseURL, cfg.APIPoolSize+cfg.WorkerPoolSize, boot.PoolRoleWorker)
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
	// BOTH background loops must be drained before the deferred
	// pool.Close() above runs (defers unwind LIFO). The reaper used to be
	// an unsynchronized `go`, so a normal stdio session teardown could
	// leave it querying a pool that was already closing.
	var background sync.WaitGroup
	background.Go(func() {
		_ = eng.RunWorkers(workerCtx, cfg.WorkerConcurrency, cfg.PollInterval, dispatcher.Execute, logger)
	})
	background.Go(func() {
		eng.StartReaper(workerCtx, time.Minute, time.Hour, logger)
	})
	defer func() { stopWorkers(); background.Wait() }()

	org := os.Getenv("JANUSLY_ORG")
	if org == "" {
		org = "default"
	}
	permissions, err := mcpserver.ParsePermissionCeiling(os.Getenv("JANUSLY_MCP_PERMISSIONS"))
	if err != nil {
		return err
	}
	tracker := ratelimit.NewTracker(pool)
	limiter := ratelimit.New(pool, ratelimit.Hooks{
		OnError: tracker.RecordError, OnSuccess: tracker.RecordRecovery,
	})
	server := mcpserver.NewServer(mcpserver.Deps{
		Engine: eng, Pool: pool, OrgID: org, UserID: "mcp", NewID: uuid.NewString,
		Permissions: permissions, CatalogSource: mcpclient.New(pool, limiter), Limiter: limiter,
	})
	logger.Info("mcp server ready", "org", org,
		"permissions", mcpserver.PermissionKeys(permissions),
		"startup", time.Now().UTC().Format(time.RFC3339))
	return server.Run(ctx, &mcp.StdioTransport{})
}
