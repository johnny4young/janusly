// Postgres-backed rate limiter — the runtime's deliberate architecture
// divergence from the contract's Redis limiter (operator decision:
// one binary, one database; Redis returns only if business demands it).
// Semantics are the contract's verbatim: fixed window per (name, key),
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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// Hooks observe limiter round-trips. Both are wrapped so a hook bug can
// NEVER break the fail-open invariant.
type Hooks struct {
	OnError   func(bucket, key string, err error)
	OnSuccess func(bucket, key string)
}

// Options mirror the contract's RateLimitOptions.
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

// TriggerEventSettledError tells the trigger pipeline that another contender
// changed the durable event out of `received` while this request waited on the
// admission lock. It is not an infrastructure error and must converge to the
// persisted duplicate result instead of continuing toward StartRun.
type TriggerEventSettledError struct {
	Status string
}

func (e *TriggerEventSettledError) Error() string {
	return "trigger event was already settled as " + e.Status
}

// TriggerAdmissionIndeterminateError means the atomic counter/event-state
// transaction reached Commit but its result was not observable. Unlike an
// ordinary limiter store outage, allowing the request here could start a run
// whose event actually committed as skipped. The caller must fail this attempt
// and let a retry converge from the durable row.
type TriggerAdmissionIndeterminateError struct {
	Cause error
}

func (e *TriggerAdmissionIndeterminateError) Error() string {
	return "trigger admission commit result is indeterminate"
}

func (e *TriggerAdmissionIndeterminateError) Unwrap() error { return e.Cause }

// Limiter enforces fixed windows over rate_limit_windows.
type Limiter struct {
	pool     *pgxpool.Pool
	hooks    Hooks
	now      func() time.Time
	commitTx func(context.Context, pgx.Tx) error
}

// New builds a limiter over the shared pool. SetNow exists for tests.
func New(pool *pgxpool.Pool, hooks Hooks) *Limiter {
	return &Limiter{
		pool: pool, hooks: hooks, now: time.Now,
		commitTx: func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) },
	}
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

// EnforceTriggerEvent counts one fixed-window hit exactly once for a durable
// trigger event. The event row is locked and its admission marker is committed
// in the same transaction as the counter increment. A retry after a crash can
// therefore continue toward StartRun without consuming the storm budget again.
// Store failures retain the limiter's fail-open posture.
func (l *Limiter) EnforceTriggerEvent(
	ctx context.Context,
	key string,
	orgID string,
	eventID string,
	opts Options,
) error {
	now := l.now().UTC()
	windowStart := now.Truncate(opts.Window)
	expiresAt := windowStart.Add(opts.Window)
	tx, err := l.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return l.failOpen(opts.Name, key, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)

	admission, err := q.GetTriggerEventRateAdmissionForUpdate(ctx, store.GetTriggerEventRateAdmissionForUpdateParams{
		OrgID: orgID, ID: eventID,
	})
	if err != nil {
		return l.failOpen(opts.Name, key, err)
	}
	if admission.Status != "received" {
		// No state changed in this transaction. Rollback only releases the row
		// lock; the already-durable settlement remains authoritative.
		_ = tx.Rollback(ctx)
		l.fireSuccess(opts.Name, key)
		return &TriggerEventSettledError{Status: admission.Status}
	}
	if admission.RateAdmittedAt != nil {
		// Likewise, the admission marker pre-dates this read-only transaction.
		_ = tx.Rollback(ctx)
		l.fireSuccess(opts.Name, key)
		return nil
	}

	count, err := q.BumpRateWindow(ctx, store.BumpRateWindowParams{
		Name: opts.Name, Key: key, WindowStart: windowStart, ExpiresAt: expiresAt,
	})
	if err != nil {
		return l.failOpen(opts.Name, key, err)
	}
	if int(count) > opts.Max {
		updated, updateErr := q.MarkTriggerEventRateLimited(ctx, store.MarkTriggerEventRateLimitedParams{
			OrgID: orgID, ID: eventID,
		})
		if updateErr != nil || updated != 1 {
			if updateErr == nil {
				updateErr = fmt.Errorf("trigger event rate-limit settlement updated %d rows", updated)
			}
			return l.failOpen(opts.Name, key, updateErr)
		}
		if err := l.commitTx(ctx, tx); err != nil {
			return l.indeterminate(opts.Name, key, err)
		}
		l.fireSuccess(opts.Name, key)
		retryAfter := max(int(expiresAt.Sub(now).Seconds())+1, 1)
		return &LimitError{Bucket: opts.Name, RetryAfterSec: retryAfter}
	}

	updated, err := q.MarkTriggerEventRateAdmitted(ctx, store.MarkTriggerEventRateAdmittedParams{
		OrgID: orgID, ID: eventID, RateAdmittedAt: &now,
	})
	if err != nil || updated != 1 {
		if err == nil {
			err = fmt.Errorf("trigger event rate admission updated %d rows", updated)
		}
		return l.failOpen(opts.Name, key, err)
	}
	if err := l.commitTx(ctx, tx); err != nil {
		return l.indeterminate(opts.Name, key, err)
	}
	l.fireSuccess(opts.Name, key)
	return nil
}

func (l *Limiter) failOpen(bucket, key string, err error) error {
	fireHook(func() { l.hooks.OnError(bucket, key, err) }, l.hooks.OnError == nil)
	slog.Warn("[rate-limit] postgres error, failing open", "bucket", bucket, "error", err)
	return nil
}

func (l *Limiter) indeterminate(bucket, key string, err error) error {
	fireHook(func() { l.hooks.OnError(bucket, key, err) }, l.hooks.OnError == nil)
	slog.Error("[rate-limit] trigger admission commit indeterminate, failing attempt closed",
		"bucket", bucket, "error", err)
	return &TriggerAdmissionIndeterminateError{Cause: err}
}

func (l *Limiter) fireSuccess(bucket, key string) {
	fireHook(func() { l.hooks.OnSuccess(bucket, key) }, l.hooks.OnSuccess == nil)
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
