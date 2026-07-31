// Audit writers, ported from the reference's two chokepoints:
//
//	Write        the module-level best-effort writer (apps/api/src/audit.ts)
//	             — a failed audit insert on a non-transactional path is
//	             logged and swallowed, never breaking the operation.
//	WithAuditTx  the transactional pairing (packages/data/src/audit-tx.ts)
//	             — the entity write and its audit row commit or roll back
//	             TOGETHER; the handler receives a tx-bound audit function,
//	             and here the compiler enforces what the reference could
//	             only enforce by naming convention.
//	ForAction    the typed helper (auditAction): action validated against
//	             the closed catalog, caller metadata enriched with the
//	             auth-derived source + actor block, which WINS on key
//	             collision — the forensic fields are never caller-shaped.
//
// Every metadata payload passes the sensitive-key redaction before it
// lands in jsonb (the full safePersistPayload chokepoint follows in its
// own ticket; key-redaction is already the load-bearing layer).
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// Options mirror the reference's AuditActionOptions.
type Options struct {
	TargetType string
	TargetID   string
	Metadata   map[string]any
}

// enrich applies the reference's collision rule: the auth-derived block
// overwrites caller keys.
func enrich(authCtx *auth.Context, metadata map[string]any) map[string]any {
	enriched := map[string]any{}
	for key, value := range metadata {
		enriched[key] = value
	}
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

func marshalMetadata(metadata map[string]any) ([]byte, error) {
	redacted, _ := grammar.RedactSensitiveKeys(metadata).(map[string]any)
	if redacted == nil {
		redacted = map[string]any{}
	}
	return json.Marshal(redacted)
}

// created_at is stamped app-side truncated to milliseconds (the T-058
// posture): the read surface's `<iso>|<id>` cursor lives in JS Date ms
// precision, and a ms cursor over µs rows can skip page-boundary peers.
const insertSQL = `INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata, created_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

func insert(ctx context.Context, exec func(context.Context, string, ...any) error,
	orgID, userID string, action Action, opts Options, authCtx *auth.Context) error {
	if !IsKnown(action) {
		return fmt.Errorf("audit action %q is not in the catalog", action)
	}
	metadata, err := marshalMetadata(enrich(authCtx, opts.Metadata))
	if err != nil {
		return fmt.Errorf("marshal audit metadata: %w", err)
	}
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
func Write(ctx context.Context, pool *pgxpool.Pool, authCtx *auth.Context, action Action, opts Options) {
	orgID, userID := "", ""
	if authCtx != nil {
		orgID, userID = authCtx.OrgID, authCtx.UserID
	}
	err := insert(ctx, func(ctx context.Context, sql string, args ...any) error {
		_, execErr := pool.Exec(ctx, sql, args...)
		return execErr
	}, orgID, userID, action, opts, authCtx)
	if err != nil {
		slog.Warn("audit write failed", "action", string(action), "error", err)
	}
}

// SystemWrite records a system-actor row (no auth context; orgId may be
// the "system" sentinel) — the degradation/budget/watcher writers' shape.
func SystemWrite(ctx context.Context, pool *pgxpool.Pool, orgID, actor string, action Action, opts Options) {
	if opts.Metadata == nil {
		opts.Metadata = map[string]any{}
	}
	opts.Metadata["actor"] = actor
	err := insert(ctx, func(ctx context.Context, sql string, args ...any) error {
		_, execErr := pool.Exec(ctx, sql, args...)
		return execErr
	}, orgID, "", action, opts, nil)
	if err != nil {
		slog.Warn("system audit write failed", "action", string(action), "error", err)
	}
}

// TxAudit is the tx-bound audit function handed to WithAuditTx handlers.
type TxAudit func(action Action, opts Options) error

// WithAuditTx runs the handler inside one transaction with a tx-bound
// audit writer: entity rows and audit rows commit or roll back together.
// Unlike the best-effort writer, a failed audit insert here FAILS the
// transaction — that is the whole point of the pairing.
func WithAuditTx(ctx context.Context, pool *pgxpool.Pool, authCtx *auth.Context,
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
		return insert(ctx, func(ctx context.Context, sql string, args ...any) error {
			_, execErr := tx.Exec(ctx, sql, args...)
			return execErr
		}, orgID, userID, action, opts, authCtx)
	}
	if err := handler(tx, txAudit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
