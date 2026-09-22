package tools

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	errDbPoolExhausted = errors.New("db_pool_exhausted")
	errDbPoolsClosed   = errors.New("db_pools_closed")
	dbToolPools        = newDbPoolCache()
	metricDbToolPools  = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "janusly_db_tool_pools",
		Help: "Live external db-tool pools, including retired pools still draining.",
	})
)

// A lease spans acquisition, transaction and rollback. Retirement prevents new
// leases; the final caller closes the pool, outside the cache lock. No reaper or
// unbounded per-rotation goroutine is needed, and in-flight work keeps its pool.
type dbPoolLease struct {
	pool    *pgxpool.Pool
	release func()
	once    sync.Once
}

func (l *dbPoolLease) Release() { l.once.Do(l.release) }

type dbPoolEntry struct {
	pool             *pgxpool.Pool
	key, orgID       string
	fingerprint      [32]byte
	touchedAt        time.Time
	leases           int
	retired, closing bool
}

type dbPoolCache struct {
	mu      sync.Mutex
	entries map[string]*dbPoolEntry
	live    map[*dbPoolEntry]struct{}
	closed  bool
	drained chan struct{}
}

func newDbPoolCache() *dbPoolCache {
	return &dbPoolCache{entries: make(map[string]*dbPoolEntry), live: make(map[*dbPoolEntry]struct{}), drained: make(chan struct{})}
}

func dbMaxProcessPools() int {
	if n, err := strconv.Atoi(os.Getenv("JANUSLY_DB_TOOL_MAX_PROCESS_POOLS")); err == nil && n >= 1 && n <= 500 {
		return n
	}
	return dbMaxProcessPoolsDefault
}

func getDbPool(ctx context.Context, orgID, credentialName, dsn string) (*dbPoolLease, error) {
	return dbToolPools.acquire(ctx, orgID, credentialName, dsn)
}

func (c *dbPoolCache) acquire(ctx context.Context, orgID, credentialName, dsn string) (*dbPoolLease, error) {
	// Parsing may read local pg service/password configuration; keep it outside
	// the mutex. The credential value never appears in cache errors or metrics.
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid postgres credential value")
	}
	config.MaxConns, config.MinConns, config.MinIdleConns = 1, 0, 0
	config.ConnConfig.ConnectTimeout = 10 * time.Second
	key := orgID + "\x00" + credentialName
	fingerprint := sha256.Sum256([]byte(dsn))
	for {
		c.mu.Lock()
		lease, victim, err := c.acquireLocked(ctx, key, orgID, fingerprint, config)
		c.mu.Unlock()
		if victim == nil {
			return lease, err
		}
		// Idle eviction or idle rotation can free capacity synchronously without
		// delaying any other tenant on the mutex. Count it until Close returns.
		c.closeEntry(victim)
	}
}

func (c *dbPoolCache) acquireLocked(ctx context.Context, key, orgID string, fingerprint [32]byte, config *pgxpool.Config) (*dbPoolLease, *dbPoolEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if c.closed {
		return nil, nil, errDbPoolsClosed
	}
	if existing := c.entries[key]; existing != nil {
		if existing.fingerprint == fingerprint {
			return c.leaseLocked(existing), nil, nil
		}
		if c.retireLocked(existing) {
			return nil, existing, nil
		}
	}
	// Retired pools still own a physical slot. Only idle same-org LRU entries
	// may be evicted; never close a busy victim or steal another tenant's pool.
	orgCount := 0
	var oldest *dbPoolEntry
	for entry := range c.live {
		if entry.orgID != orgID {
			continue
		}
		orgCount++
		if !entry.retired && entry.leases == 0 && (oldest == nil || entry.touchedAt.Before(oldest.touchedAt)) {
			oldest = entry
		}
	}
	if orgCount >= dbMaxOrgPools {
		if oldest == nil {
			return nil, nil, errDbPoolExhausted
		}
		c.retireLocked(oldest)
		return nil, oldest, nil
	}
	if len(c.live) >= dbMaxProcessPools() {
		return nil, nil, errDbPoolExhausted
	}
	// NewWithConfig is lazy: with both minimums zero it constructs the pool
	// without dialing. Admission and publication share one lock, so concurrent
	// creators cannot duplicate a key or oversubscribe the physical pool cap.
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, nil, errors.New("could not open external database pool")
	}
	entry := &dbPoolEntry{pool: pool, key: key, orgID: orgID, fingerprint: fingerprint}
	c.entries[key] = entry
	c.live[entry] = struct{}{}
	metricDbToolPools.Set(float64(len(c.live)))
	return c.leaseLocked(entry), nil, nil
}

func (c *dbPoolCache) leaseLocked(entry *dbPoolEntry) *dbPoolLease {
	entry.leases++
	entry.touchedAt = time.Now()
	return &dbPoolLease{pool: entry.pool, release: func() { c.release(entry) }}
}

// retireLocked transfers closure ownership only when the last lease is gone.
func (c *dbPoolCache) retireLocked(entry *dbPoolEntry) bool {
	delete(c.entries, entry.key)
	entry.retired = true
	if entry.leases == 0 && !entry.closing {
		entry.closing = true
		return true
	}
	return false
}

func (c *dbPoolCache) release(entry *dbPoolEntry) {
	c.mu.Lock()
	entry.leases--
	closeNow := entry.retired && entry.leases == 0 && !entry.closing
	if closeNow {
		entry.closing = true
	}
	c.mu.Unlock()
	if closeNow {
		c.closeEntry(entry)
	}
}

func (c *dbPoolCache) closeEntry(entry *dbPoolEntry) {
	entry.pool.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.live, entry)
	metricDbToolPools.Set(float64(len(c.live)))
	if c.closed && len(c.live) == 0 {
		close(c.drained)
	}
}

func (c *dbPoolCache) close() {
	c.mu.Lock()
	var idle []*dbPoolEntry
	if !c.closed {
		c.closed = true
		for _, entry := range c.entries {
			if c.retireLocked(entry) {
				idle = append(idle, entry)
			}
		}
		if len(c.live) == 0 {
			close(c.drained)
		}
	}
	c.mu.Unlock()
	for _, entry := range idle {
		c.closeEntry(entry)
	}
	<-c.drained
}

// CloseDbPools stops admission and waits for all external pool leases to drain.
// The runtime calls it after stopping tool producers (HTTP and workers).
func CloseDbPools() { dbToolPools.close() }

// ResetDbPoolsForTests must only run with test callers stopped. Unlike terminal
// production shutdown, it installs a fresh accepting cache for the next test.
func ResetDbPoolsForTests() {
	CloseDbPools()
	dbToolPools = newDbPoolCache()
}
