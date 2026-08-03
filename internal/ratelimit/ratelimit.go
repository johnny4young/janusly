// Postgres-backed rate limiter — the pilot's deliberate architecture
// divergence from the reference's Redis limiter (operator decision:
// one binary, one database; Redis returns only if business demands it).
// Semantics are the reference's verbatim: fixed window per (name, key),
// FAIL OPEN on store errors with a "[rate-limit]" warn (never fail
// closed — an infrastructure blip must not cascade into a wall of 429s),
// hooks fired on every store success/error for the degradation tracker,
// and the exact 429 message "Rate limit exceeded for <name>. Retry in Ns.".
package ratelimit

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// Hooks observe limiter round-trips. Both are wrapped so a hook bug can
// NEVER break the fail-open invariant.
type Hooks struct {
	OnError   func(bucket, key string, err error)
	OnSuccess func(bucket, key string)
}

// Options mirror the reference's RateLimitOptions.
type Options struct {
	// Name is the bucket label (e.g. "api:start", "trigger:ingest").
	Name string
	// Max hits allowed inside one window.
	Max int
	// Window is the fixed-window duration.
	Window time.Duration
}

// LimitError is the over-limit outcome, carrying the wire fields.
type LimitError struct {
	Bucket        string
	RetryAfterSec int
}

func (e *LimitError) Error() string {
	return fmt.Sprintf("Rate limit exceeded for %s. Retry in %ds.", e.Bucket, e.RetryAfterSec)
}

// Limiter enforces fixed windows over rate_limit_windows.
type Limiter struct {
	pool  *pgxpool.Pool
	hooks Hooks
	now   func() time.Time
}

// New builds a limiter over the shared pool. SetNow exists for tests.
func New(pool *pgxpool.Pool, hooks Hooks) *Limiter {
	return &Limiter{pool: pool, hooks: hooks, now: time.Now}
}

// SetNow overrides the clock (tests only).
func (l *Limiter) SetNow(now func() time.Time) { l.now = now }

// Enforce counts one hit and returns *LimitError when the bucket is over
// its window budget. A store failure fails OPEN: the hit is allowed, the
// error hook fires, and a warn names the bucket.
func (l *Limiter) Enforce(ctx context.Context, key string, opts Options) error {
	now := l.now().UTC()
	windowStart := now.Truncate(opts.Window)
	expiresAt := windowStart.Add(opts.Window)
	count, err := store.New(l.pool).BumpRateWindow(ctx, store.BumpRateWindowParams{
		Name: opts.Name, Key: key,
		WindowStart: windowStart, ExpiresAt: expiresAt,
	})
	if err != nil {
		fireHook(func() { l.hooks.OnError(opts.Name, key, err) }, l.hooks.OnError == nil)
		slog.Warn("[rate-limit] postgres error, failing open", "bucket", opts.Name, "error", err)
		return nil
	}
	// Success hook fires BEFORE the over-limit check — a 429-producing call
	// still counts as a "store worked" signal.
	fireHook(func() { l.hooks.OnSuccess(opts.Name, key) }, l.hooks.OnSuccess == nil)
	if int(count) > opts.Max {
		retryAfter := max(int(time.Until(expiresAt).Seconds())+1, 1)
		return &LimitError{Bucket: opts.Name, RetryAfterSec: retryAfter}
	}
	return nil
}

// CleanupExpired removes windows whose expiry passed; wired to the
// engine's maintenance cadence so the table never accumulates.
func CleanupExpired(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	return store.New(pool).CleanupExpiredRateWindows(ctx)
}

// fireHook runs a hook defensively: nil-safe and panic-absorbing.
func fireHook(run func(), skip bool) {
	if skip {
		return
	}
	defer func() { _ = recover() }()
	run()
}
