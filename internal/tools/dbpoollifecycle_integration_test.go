//go:build integration

package tools

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDbPoolRotationDoesNotWaitForConnection(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ResetDbPoolsForTests()
	t.Cleanup(ResetDbPoolsForTests)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	lease, err := getDbPool(ctx, "rotation-a", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	conn, err := lease.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rotated := make(chan error, 1)
	go func() {
		_, err := getIdleDbPool(ctx, "rotation-a", "db", dsn+"&application_name=rotated")
		rotated <- err
	}()
	defer func() { conn.Release(); <-rotated }()
	select {
	case err := <-rotated:
		rotated <- err // leave the cleanup ownership intact
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("credential rotation waited for the previous caller's connection")
	}
	if _, err := getIdleDbPool(ctx, "rotation-b", "db", dsn); err != nil {
		t.Fatalf("other tenant blocked: %v", err)
	}
}

// Warm a cache entry without leaving a caller lease alive.
func getIdleDbPool(ctx context.Context, org, credential, dsn string) (*pgxpool.Pool, error) {
	lease, err := getDbPool(ctx, org, credential, dsn)
	if err != nil {
		return nil, err
	}
	defer lease.Release()
	return lease.pool, nil
}

func dbPoolTestContext(t *testing.T) (context.Context, string) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ResetDbPoolsForTests()
	t.Cleanup(ResetDbPoolsForTests)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx, dsn
}

func TestDbPoolRetiredCapacityDoesNotBlockOtherTenant(t *testing.T) {
	ctx, dsn := dbPoolTestContext(t)
	t.Setenv("JANUSLY_DB_TOOL_MAX_PROCESS_POOLS", "2")
	old, err := getDbPool(ctx, "a", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Release()
	conn, err := old.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := getIdleDbPool(ctx, "b", "db", dsn); err != nil {
		t.Fatal(err)
	}
	rotatedDSN := dsn + "&application_name=rotation-cap"
	if _, err := getDbPool(ctx, "a", "db", rotatedDSN); !errors.Is(err, errDbPoolExhausted) {
		t.Fatalf("live retired pool must consume capacity: %v", err)
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != 2 {
		t.Fatalf("live gauge=%v", got)
	}
	bounded, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	other, err := getDbPool(bounded, "b", "db", dsn)
	if err != nil {
		t.Fatalf("unrelated tenant: %v", err)
	}
	if _, err := other.pool.Exec(bounded, "SELECT 1"); err != nil {
		t.Fatal(err)
	}
	other.Release()
	if _, err := conn.Exec(ctx, "SELECT 1"); err != nil {
		t.Fatalf("rotation invalidated a current lease: %v", err)
	}
	conn.Release()
	old.Release()
	fresh, err := getDbPool(ctx, "a", "db", rotatedDSN)
	if err != nil {
		t.Fatalf("capacity not recovered: %v", err)
	}
	defer fresh.Release()
	if fresh.pool == old.pool {
		t.Fatal("retired pool republished")
	}
	if conn, err := old.pool.Acquire(ctx); err == nil {
		conn.Release()
		t.Fatal("retired pool not closed")
	}
}

func TestDbPoolRetiredRotationsRespectPhysicalOrgCap(t *testing.T) {
	ctx, dsn := dbPoolTestContext(t)
	var leases []*dbPoolLease
	defer func() {
		for _, lease := range leases {
			lease.Release()
		}
	}()
	for i := range dbMaxOrgPools {
		lease, err := getDbPool(ctx, "rotate", "db", dsn+fmt.Sprintf("&application_name=rotation-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		leases = append(leases, lease)
		if _, err := lease.pool.Exec(ctx, "SELECT 1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := getDbPool(ctx, "rotate", "db", dsn+"&application_name=over-cap"); !errors.Is(err, errDbPoolExhausted) {
		t.Fatalf("retired rotations escaped org cap: %v", err)
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != dbMaxOrgPools {
		t.Fatalf("live gauge=%v", got)
	}
	for _, lease := range leases {
		lease.Release()
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != 0 {
		t.Fatalf("retired pools leaked: %v", got)
	}
	if _, err := getIdleDbPool(ctx, "rotate", "db", dsn); err != nil {
		t.Fatal(err)
	}
}

func TestDbPoolLRUEvictsOnlyIdleSameTenant(t *testing.T) {
	ctx, dsn := dbPoolTestContext(t)
	busy, err := getDbPool(ctx, "lru", "busy", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Release()
	oldest, err := getIdleDbPool(ctx, "lru", "idle-0", dsn)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < dbMaxOrgPools-1; i++ {
		if _, err := getIdleDbPool(ctx, "lru", fmt.Sprint(i), dsn); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := getIdleDbPool(ctx, "lru", "replacement", dsn); err != nil {
		t.Fatal(err)
	}
	if _, err := busy.pool.Exec(ctx, "SELECT 1"); err != nil {
		t.Fatalf("evicted leased pool: %v", err)
	}
	if conn, err := oldest.Acquire(ctx); err == nil {
		conn.Release()
		t.Fatal("oldest idle pool not closed")
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != dbMaxOrgPools {
		t.Fatalf("LRU physical count=%v", got)
	}
}

func TestDbPoolConcurrentAdmissionAndShutdown(t *testing.T) {
	ctx, dsn := dbPoolTestContext(t)
	cache := dbToolPools
	const callers = 24
	leases := make(chan *dbPoolLease, callers)
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Go(func() {
			lease, err := cache.acquire(ctx, "concurrent", "db", dsn)
			if err != nil {
				errs <- err
				return
			}
			leases <- lease
		})
	}
	wg.Wait()
	close(leases)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	var all []*dbPoolLease
	defer func() {
		for _, lease := range all {
			lease.Release()
		}
	}()
	for lease := range leases {
		if len(all) > 0 && all[0].pool != lease.pool {
			t.Error("duplicate pool published for key")
		}
		all = append(all, lease)
	}
	if len(all) != callers {
		t.Fatalf("leases=%d", len(all))
	}
	done := make(chan struct{})
	go func() { cache.close(); close(done) }()
	// Observe closed admission rather than relying on scheduler sleeps.
	for {
		cache.mu.Lock()
		closed := cache.closed
		cache.mu.Unlock()
		if closed {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if _, err := cache.acquire(ctx, "new", "db", dsn); !errors.Is(err, errDbPoolsClosed) {
		t.Fatalf("shutdown allowed admission: %v", err)
	}
	select {
	case <-done:
		t.Fatal("shutdown returned before caller drain")
	default:
	}
	for _, lease := range all {
		if _, err := lease.pool.Exec(ctx, "SELECT 1"); err != nil {
			t.Fatalf("shutdown invalidated in-flight lease: %v", err)
		}
		lease.Release()
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("shutdown did not drain")
	}
	cache.close() // terminal close is idempotent
	if got := testutil.ToFloat64(metricDbToolPools); got != 0 {
		t.Fatalf("shutdown gauge=%v", got)
	}
}

func TestDbToolTimeoutCoversConnectionWait(t *testing.T) {
	ctx, dsn := dbPoolTestContext(t)
	lease, err := getDbPool(ctx, "waiter", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	conn, err := lease.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	deps := &IntegrationDeps{
		Gate:  func(context.Context, string, string, string, int) (string, string) { return dsn, "" },
		OrgID: func() string { return "waiter" },
	}
	result := make(chan map[string]any, 1)
	go func() {
		result <- executeDbTool(ctx, "db.query.read", map[string]any{"credential": "db", "sql": "select 1", "timeoutMs": float64(50)}, deps)
	}()
	select {
	case got := <-result:
		if got["ok"] != false || !strings.Contains(fmt.Sprint(got["error"]), "deadline") {
			t.Fatalf("timeout envelope=%v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout excludes connection acquisition")
	}
	conn.Release()
	lease.Release()
	CloseDbPools() // canceled waiter released its lease, so this cannot hang
}

func TestDbPoolConcurrentRotationsStayBounded(t *testing.T) {
	ctx, dsn := dbPoolTestContext(t)
	t.Setenv("JANUSLY_DB_TOOL_MAX_PROCESS_POOLS", "6")
	cache := dbToolPools
	var wg sync.WaitGroup
	for worker := range 8 {
		wg.Go(func() {
			for generation := range 12 {
				org := fmt.Sprintf("org-%d", worker%2)
				lease, err := cache.acquire(ctx, org, "db", dsn+fmt.Sprintf("&application_name=concurrent-%d-%d", worker, generation))
				if errors.Is(err, errDbPoolExhausted) {
					continue
				}
				if err != nil {
					t.Errorf("admission: %v", err)
					return
				}
				if _, err := lease.pool.Exec(ctx, "SELECT 1"); err != nil {
					t.Errorf("retired live lease: %v", err)
				}
				cache.mu.Lock()
				counts := map[string]int{}
				for entry := range cache.live {
					counts[entry.orgID]++
				}
				if len(cache.live) > 6 || counts["org-0"] > dbMaxOrgPools || counts["org-1"] > dbMaxOrgPools {
					t.Error("physical pool capacity exceeded")
				}
				cache.mu.Unlock()
				lease.Release()
			}
		})
	}
	wg.Wait()
	CloseDbPools()
	if got := testutil.ToFloat64(metricDbToolPools); got != 0 {
		t.Fatalf("live pools after concurrent drain=%v", got)
	}
}
