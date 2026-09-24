// Package audit writes bounded, redacted receipts with immutable process policy.
// Best-effort methods log failures without breaking the operation; transactional
// methods preserve the caller's connection and propagate failures for rollback.
// Auth-derived actor metadata wins over caller fields, and actions are checked
// against the closed catalog before insertion.
package audit

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/grammar"
)

// Writer carries immutable serialization policy, never a pool or transaction.
// The zero value uses the contract default. Callers retain connection ownership.
type Writer struct{ persistence grammar.Persister }

// NewWriter shares the process persistence policy with audit producers.
func NewWriter(persistence grammar.Persister) Writer { return Writer{persistence: persistence} }

// Options mirror the contract's AuditActionOptions.
type Options struct {
	TargetType string
	TargetID   string
	Metadata   map[string]any
}

// enrich applies the contract's collision rule: the auth-derived block
// overwrites caller keys.
func enrich(authCtx *auth.Context, metadata map[string]any) map[string]any {
	enriched := map[string]any{}
	maps.Copy(enriched, metadata)
	if authCtx != nil {
		enriched["source"] = string(authCtx.Source)
		actor := map[string]any{"userId": authCtx.UserID, "mode": string(authCtx.Mode)}
		if authCtx.ServiceTokenSuffix != "" {
			actor["serviceTokenSuffix"] = authCtx.ServiceTokenSuffix
		}
		enriched["actor"] = actor
	}
	return enriched
}

// marshalMetadata routes through the formal persistence chokepoint: key
// redaction plus the injected default byte cap so a
// runaway metadata blob truncates to the sentinel instead of bloating the
// audit row.
func (w Writer) marshalMetadata(metadata map[string]any) []byte {
	if metadata == nil {
		metadata = map[string]any{}
	}
	return w.persistence.Payload(metadata, grammar.PersistOptions{})
}

// created_at is stamped app-side and truncated to milliseconds; the read
// surface's `<iso>|<id>` cursor lives in JS Date ms
// precision, and a ms cursor over µs rows can skip page-boundary peers.
const insertSQL = `INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata, created_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

func (w Writer) insert(ctx context.Context, exec func(context.Context, string, ...any) error,
	orgID, userID string, action Action, opts Options, authCtx *auth.Context) error {
	if !IsKnown(action) {
		return fmt.Errorf("audit action %q is not in the catalog", action)
	}
	metadata := w.marshalMetadata(enrich(authCtx, opts.Metadata))
	var targetType, targetID any
	if opts.TargetType != "" {
		targetType = opts.TargetType
	}
	if opts.TargetID != "" {
		targetID = opts.TargetID
	}
	var userValue any
	if userID != "" {
		userValue = userID
	}
	return exec(ctx, insertSQL, uuid.NewString(), orgID, userValue, string(action), targetType, targetID, metadata,
		time.Now().UTC().Truncate(time.Millisecond))
}

// Write is the best-effort non-transactional writer: failures are logged
// and swallowed so telemetry never breaks the operation it describes.
func (w Writer) Write(ctx context.Context, pool *pgxpool.Pool, authCtx *auth.Context, action Action, opts Options) {
	orgID, userID := "", ""
	if authCtx != nil {
		orgID, userID = authCtx.OrgID, authCtx.UserID
	}
	err := w.insert(ctx, func(ctx context.Context, sql string, args ...any) error {
		_, execErr := pool.Exec(ctx, sql, args...)
		return execErr
	}, orgID, userID, action, opts, authCtx)
	if err != nil {
		slog.Warn("audit write failed", "action", string(action), "error", err)
	}
}

// WriteAs records a best-effort row with an explicit user id column and
// NO auth-derived enrichment — the analogue of the contract's raw
// audit(orgId, userId, ...) writers (the budget gate uses it).
func (w Writer) WriteAs(ctx context.Context, pool *pgxpool.Pool, orgID, userID string, action Action, opts Options) {
	err := w.insert(ctx, func(ctx context.Context, sql string, args ...any) error {
		_, execErr := pool.Exec(ctx, sql, args...)
		return execErr
	}, orgID, userID, action, opts, nil)
	if err != nil {
		slog.Warn("audit write failed", "action", string(action), "error", err)
	}
}

// SystemWrite records a system-actor row (no auth context; orgId may be
// the "system" sentinel) — the degradation/budget/watcher writers' shape.
func (w Writer) SystemWrite(ctx context.Context, pool *pgxpool.Pool, orgID, actor string, action Action, opts Options) {
	err := w.SystemWriteInTx(ctx, pool, orgID, actor, action, opts)
	if err != nil {
		slog.Warn("system audit write failed", "action", string(action), "error", err)
	}
}

// SystemWriteInTx preserves the system-actor shape on a caller-owned
// transaction. It returns errors so the caller controls rollback policy.
func (w Writer) SystemWriteInTx(ctx context.Context, tx TxExecer, orgID, actor string, action Action, opts Options) error {
	metadata := make(map[string]any, len(opts.Metadata)+1)
	maps.Copy(metadata, opts.Metadata)
	if actor != "" {
		metadata["actor"] = actor
	}
	opts.Metadata = metadata
	return w.insert(ctx, func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}, orgID, "", action, opts, nil)
}

// TxAudit is the tx-bound audit function handed to WithAuditTx handlers.
type TxAudit func(action Action, opts Options) error

// TxExecer is the narrow transaction surface required by WriteInTx. Keeping
// the interface independent of pgx.Tx preserves the engine's fault-injection
// seam while making the audit receipt mandatory for governed mutations.
type TxExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// WriteInTx appends a mandatory audit row through a caller-owned transaction.
// Unlike Write, an error is returned so the business mutation rolls back
// instead of committing without its forensic receipt.
func (w Writer) WriteInTx(ctx context.Context, tx TxExecer, authCtx *auth.Context, action Action, opts Options) error {
	orgID, userID := "", ""
	if authCtx != nil {
		orgID, userID = authCtx.OrgID, authCtx.UserID
	}
	return w.insert(ctx, func(ctx context.Context, sql string, args ...any) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}, orgID, userID, action, opts, authCtx)
}

// IdentityTxAudit binds the provider-verified actor while allowing the
// transaction to supply the organization it just proved or created. This is
// the bootstrap analogue of TxAudit: an untrusted organization hint never
// reaches the audit row, and the handler cannot forge the actor identity.
type IdentityTxAudit func(orgID string, action Action, opts Options) error

// WithAuditTx runs the handler inside one transaction with a tx-bound
// audit writer: entity rows and audit rows commit or roll back together.
// Unlike the best-effort writer, a failed audit insert here FAILS the
// transaction — that is the whole point of the pairing.
func (w Writer) WithAuditTx(ctx context.Context, pool *pgxpool.Pool, authCtx *auth.Context,
	handler func(tx pgx.Tx, audit TxAudit) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin audit tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	txAudit := func(action Action, opts Options) error {
		orgID, userID := "", ""
		if authCtx != nil {
			orgID, userID = authCtx.OrgID, authCtx.UserID
		}
		return w.insert(ctx, func(ctx context.Context, sql string, args ...any) error {
			_, execErr := tx.Exec(ctx, sql, args...)
			return execErr
		}, orgID, userID, action, opts, authCtx)
	}
	if err := handler(tx, txAudit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WithIdentityAuditTx atomically pairs bootstrap writes with an audit row
// whose organization becomes known only inside the transaction. It is used by
// organization creation, invitation acceptance, and SSO provisioning; tenant
// routes should keep using WithAuditTx with their authorized Context.
func (w Writer) WithIdentityAuditTx(ctx context.Context, pool *pgxpool.Pool, identity *auth.Identity,
	handler func(tx pgx.Tx, audit IdentityTxAudit) error) error {
	if identity == nil {
		return fmt.Errorf("identity audit tx requires an identity")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin identity audit tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	txAudit := func(orgID string, action Action, opts Options) error {
		if orgID == "" {
			return fmt.Errorf("identity audit tx requires an organization")
		}
		authCtx := &auth.Context{
			OrgID: orgID, UserID: identity.UserID, Email: identity.Email,
			Mode: identity.Mode, Source: identity.Source,
			ServiceTokenSuffix: identity.ServiceTokenSuffix,
			BrowserSessionID:   identity.BrowserSessionID,
		}
		return w.insert(ctx, func(ctx context.Context, sql string, args ...any) error {
			_, execErr := tx.Exec(ctx, sql, args...)
			return execErr
		}, orgID, identity.UserID, action, opts, authCtx)
	}
	if err := handler(tx, txAudit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
