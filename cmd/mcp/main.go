// Command mcp runs Janusly's MCP stdio server: a thin in-process layer
// over the engine (no HTTP hop) that lets an agent save workflows, start
// and inspect runs, and drive the dead-letter redrive loop. The process
// also runs the worker pool so runs progress with no other service up.
//
// With JANUSLY_AGENT_TOKEN set, every call acts as that agent client and its
// organization; otherwise JANUSLY_ORG (default "default") and the operator
// ceiling in JANUSLY_MCP_PERMISSIONS apply.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/boot"
	"github.com/johnny4young/janusly/internal/config"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/mcpserver"
	"github.com/johnny4young/janusly/internal/migrate"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/tools"
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
	// Reject invalid authority before opening pools or starting workers.
	permissions, err := mcpserver.ParsePermissionCeiling(os.Getenv("JANUSLY_MCP_PERMISSIONS"))
	if err != nil {
		return err
	}
	// Logs go to stderr — stdout belongs to the MCP transport.
	logger := boot.NewStderrLogger()

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

	dbPools, err := tools.NewDBPools(cfg.DBToolMaxProcessPools)
	if err != nil {
		return err
	}
	// Registered before workers: drain external leases before the control pool.
	defer func() {
		dbPools.Close()
		logger.Info("external database pools drained")
	}()
	persistence, err := grammar.NewPersister(cfg.PersistMaxBytes)
	if err != nil {
		return err
	}
	auditWriter := audit.NewWriter(persistence)
	eng := engine.New(pool, engine.WithReaper(cfg.Reaper), engine.WithPersistence(persistence), engine.WithDBPools(dbPools))
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
		eng.StartReaper(workerCtx, logger)
	})
	defer func() { stopWorkers(); background.Wait() }()

	org := os.Getenv("JANUSLY_ORG")
	if org == "" {
		org = "default"
	}
	tracker := ratelimit.NewTracker(pool, auditWriter)
	limiter := ratelimit.New(pool, ratelimit.Hooks{
		OnError: tracker.RecordError, OnSuccess: tracker.RecordRecovery,
	})
	deps := mcpserver.Deps{
		Audit:  auditWriter,
		Engine: eng, Pool: pool, OrgID: org, UserID: "mcp", NewID: uuid.NewString,
		Permissions: permissions, CatalogSource: mcpclient.New(pool, limiter), Limiter: limiter,
		Transport: "stdio", WebBaseURL: os.Getenv("JANUSLY_WEB_BASE_URL"), Logger: logger,
	}
	if token := os.Getenv("JANUSLY_AGENT_TOKEN"); token != "" {
		resolver := agentclient.Resolver{Pool: pool}
		principal, err := resolver.Resolve(ctx, token)
		if err != nil {
			if errors.Is(err, agentclient.ErrInvalidToken) {
				deps.AuditTokenRejection(ctx, err)
			}
			return err
		}
		// Re-resolved on every call so revocation and expiry apply mid-session.
		deps.ResolveActor = func(ctx context.Context, _ mcp.Request) (*agentclient.Principal, error) {
			return resolver.Resolve(ctx, token)
		}
		logger.Info("mcp server ready", "org", principal.OrgID, "agentClient", principal.ClientID,
			"capabilities", agentclient.Strings(principal.Capabilities),
			"startup", time.Now().UTC().Format(time.RFC3339))
	} else {
		logger.Info("mcp server ready", "org", org,
			"permissions", mcpserver.PermissionKeys(permissions),
			"startup", time.Now().UTC().Format(time.RFC3339))
	}
	server := mcpserver.NewServer(deps)
	return server.Run(ctx, &mcp.StdioTransport{})
}
