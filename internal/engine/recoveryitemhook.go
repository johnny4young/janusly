// Dead-letter ownership is optional, but any incident and its successful
// audit receipt must commit with the completion that produced them.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	debounceMinSeconds = 30
	debounceMaxSeconds = 3600
)

// slaMinutesBySeverity are the contract's built-in SLA targets.
var slaMinutesBySeverity = map[string]float64{"p1": 60, "p2": 240, "p3": 1440, "p4": 10080}

// resolveSlaTarget applies `recovery.slaPolicies` overrides (partial JSON
// map, per-severity 1..43200 minutes) over the built-ins.
func resolveSlaTarget(config map[string]any, severity string, now time.Time) time.Time {
	minutes := slaMinutesBySeverity[severity]
	if minutes == 0 {
		minutes = slaMinutesBySeverity["p3"]
	}
	if raw, _ := config["recovery.slaPolicies"].(string); strings.TrimSpace(raw) != "" {
		var policies map[string]float64
		if err := json.Unmarshal([]byte(raw), &policies); err == nil {
			if override, ok := policies[severity]; ok && override >= 1 && override <= 43200 {
				minutes = override
			}
		}
	}
	return now.Add(time.Duration(minutes) * time.Minute)
}

// AutoCreateRecoveryItemInput names one dead-letter event for the hook.
type AutoCreateRecoveryItemInput struct {
	OrgID          string
	DeadLetterID   string
	WorkflowID     string
	ErrorSignature string
	CreatedBy      string
}

// autoCreateRecoveryItem uses only the completion transaction's connection.
// Savepoints retain fail-soft configuration, incident and audit boundaries;
// an unrecoverable transaction error still aborts completion.
func (e *Engine) autoCreateRecoveryItem(ctx context.Context, q *store.Queries, input AutoCreateRecoveryItemInput) error {
	tenantRows := map[string]json.RawMessage{}
	if _, err := q.TrySavepoint(ctx, func(db store.DBTX) error {
		rows, err := store.New(db).ListOrgConfigRows(ctx, input.OrgID)
		if err != nil {
			return err
		}
		for _, row := range rows {
			tenantRows[row.Key] = row.ValueJson
		}
		return nil
	}); err != nil {
		return err
	}
	config := make(map[string]any, 3)
	for _, key := range []string{"recovery.autoCreateItems", "recovery.debounceWindowSeconds", "recovery.slaPolicies"} {
		config[key], _ = orgconfig.ResolveValue(key, tenantRows, os.LookupEnv)
	}
	if enabled, _ := config["recovery.autoCreateItems"].(bool); !enabled {
		return nil
	}
	applied, err := q.TrySavepoint(ctx, func(db store.DBTX) error {
		return e.createRecoveryItem(ctx, store.New(db), input, config)
	})
	if err == nil && !applied {
		slog.Warn("optional recovery item creation failed")
	}
	return err
}

func (e *Engine) recoveryItemAudit(ctx context.Context, q *store.Queries, input AutoCreateRecoveryItemInput, action audit.Action, opts audit.Options) error {
	applied, err := q.TrySavepoint(ctx, func(db store.DBTX) error {
		return e.audit.SystemWriteInTx(ctx, db, input.OrgID, input.CreatedBy, action, opts)
	})
	if err == nil && !applied {
		slog.Warn("optional recovery item audit failed")
	}
	return err
}

func (e *Engine) createRecoveryItem(ctx context.Context, q *store.Queries, input AutoCreateRecoveryItemInput, config map[string]any) error {
	window, _ := config["recovery.debounceWindowSeconds"].(float64)

	// Failure-storm debounce: attach to a still-open same-signature
	// incident inside the window instead of spawning a new one. The alert
	// is intentionally not re-emitted on attach (a storm pages once).
	if window > 0 && input.ErrorSignature != "" && input.WorkflowID != "" {
		seconds := min(max(window, debounceMinSeconds), debounceMaxSeconds)
		notBefore := time.Now().Add(-time.Duration(seconds) * time.Second)
		parent, err := q.FindOpenRecoveryItemForDebounce(ctx, store.FindOpenRecoveryItemForDebounceParams{
			OrgID: input.OrgID, WorkflowID: pgtype.Text{String: input.WorkflowID, Valid: true},
			ErrorSignature: pgtype.Text{String: input.ErrorSignature, Valid: true},
			LastOccurredAt: notBefore,
		})
		if err == nil {
			// A re-invocation for the SAME row must not attach the row to
			// the incident it created.
			if parent.DeadLetterID == input.DeadLetterID {
				return nil
			}
			inserted, err := q.InsertRecoveryItemChild(ctx, store.InsertRecoveryItemChildParams{
				ID: e.newID(), OrgID: input.OrgID,
				RecoveryItemID: parent.ID, DeadLetterID: input.DeadLetterID,
			})
			if err != nil || inserted == 0 {
				return err
			}
			count, err := q.BumpRecoveryItemOccurrence(ctx, store.BumpRecoveryItemOccurrenceParams{
				OrgID: input.OrgID, ID: parent.ID,
			})
			if err != nil {
				return err
			}
			return e.recoveryItemAudit(ctx, q, input, "recovery.item.occurrence_attached", audit.Options{
				TargetType: "recovery-item", TargetID: parent.ID,
				Metadata: map[string]any{
					"deadLetterId": input.DeadLetterID, "occurrenceCount": count,
					"errorSignature": input.ErrorSignature, "workflowId": input.WorkflowID,
				},
			})
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}

	severity := "p3"
	if input.WorkflowID != "" {
		stored, err := q.GetWorkflowSeverityDefault(ctx, store.GetWorkflowSeverityDefaultParams{
			OrgID: input.OrgID, WorkflowID: input.WorkflowID,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil && slaMinutesBySeverity[stored.String] > 0 {
			severity = stored.String
		}
	}

	now := time.Now()
	itemID := e.newID()
	inserted, err := q.InsertRecoveryItem(ctx, store.InsertRecoveryItemParams{
		ID: itemID, OrgID: input.OrgID, DeadLetterID: input.DeadLetterID,
		WorkflowID:     pgtype.Text{String: input.WorkflowID, Valid: input.WorkflowID != ""},
		Severity:       severity,
		SlaTargetAt:    resolveSlaTarget(config, severity, now),
		ErrorSignature: pgtype.Text{String: input.ErrorSignature, Valid: input.ErrorSignature != ""},
		CreatedBy:      pgtype.Text{String: input.CreatedBy, Valid: input.CreatedBy != ""},
	})
	if err != nil || inserted == 0 {
		return err // duplicate is an idempotent no-op; errors roll back the savepoint
	}
	return e.recoveryItemAudit(ctx, q, input, "recovery.item.created", audit.Options{
		TargetType: "recovery-item", TargetID: itemID,
		Metadata: map[string]any{
			"deadLetterId": input.DeadLetterID, "severity": severity,
			"errorSignature": input.ErrorSignature, "workflowId": input.WorkflowID,
		},
	})
}
