// DLQ → recovery_items auto-create hook (reference the source contract
// recovery/recovery-item-hook.ts): every dead-letter insert opens (or
// debounce-attaches to) an ownership incident so the queue view carries
// severity/SLA from the moment of failure — no operator action required.
//
// Invariants ported:
//   - `recovery.autoCreateItems` (default true) gates creation;
//     `recovery.debounceWindowSeconds` (0 disables; non-zero clamped to
//     30..3600) groups same-(workflow, signature) storms onto one OPEN
//     incident: the child row is idempotent on (item, deadLetter) and the
//     parent counter bumps ONLY when a child was actually inserted.
//   - Severity default: the workflow's metadata row may declare p1..p4;
//     otherwise p3. SLA target = created_at + per-severity minutes from
//     `recovery.slaPolicies` overrides (p1=60, p2=240, p3=1440, p4=10080
//     built-ins; per-severity range 1..43200).
//   - The hook NEVER fails the caller — a blip degrades to "no incident",
//     the contract posture.
package engine

import (
	"context"
	"encoding/json"
	"strings"
	"time"

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

// autoCreateRecoveryItem runs the hook against the caller's queries handle
// (tx-bound at the DLQ insert site, so incident and dead letter commit
// together). Errors degrade silently — telemetry never breaks completion.
func (e *Engine) autoCreateRecoveryItem(ctx context.Context, q *store.Queries, input AutoCreateRecoveryItemInput) {
	// ONE config read for the three keys this hook needs. The caller holds
	// an open completion transaction plus its per-run advisory lock, so the
	// three separate reads this replaced took three more pool connections
	// each — precisely during the mass-failure storms this hook exists to
	// handle, when every worker is in the same state. Deliberately still on
	// e.pool, not the transaction's connection: a failed config read must
	// keep degrading silently instead of poisoning the completion tx.
	config := orgconfig.LoadValues(ctx, e.pool, input.OrgID,
		"recovery.autoCreateItems", "recovery.debounceWindowSeconds", "recovery.slaPolicies")
	if enabled, _ := config["recovery.autoCreateItems"].(bool); !enabled {
		return
	}
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
				return
			}
			inserted, err := q.InsertRecoveryItemChild(ctx, store.InsertRecoveryItemChildParams{
				ID: e.newID(), OrgID: input.OrgID,
				RecoveryItemID: parent.ID, DeadLetterID: input.DeadLetterID,
			})
			if err != nil || inserted == 0 {
				return
			}
			count, err := q.BumpRecoveryItemOccurrence(ctx, store.BumpRecoveryItemOccurrenceParams{
				OrgID: input.OrgID, ID: parent.ID,
			})
			if err == nil {
				audit.SystemWrite(ctx, e.pool, input.OrgID, input.CreatedBy,
					"recovery.item.occurrence_attached", audit.Options{
						TargetType: "recovery-item", TargetID: parent.ID,
						Metadata: map[string]any{
							"deadLetterId": input.DeadLetterID, "occurrenceCount": count,
							"errorSignature": input.ErrorSignature, "workflowId": input.WorkflowID,
						},
					})
			}
			return
		}
	}

	severity := "p3"
	if input.WorkflowID != "" {
		if stored, err := q.GetWorkflowSeverityDefault(ctx, store.GetWorkflowSeverityDefaultParams{
			OrgID: input.OrgID, WorkflowID: input.WorkflowID,
		}); err == nil && slaMinutesBySeverity[stored.String] > 0 {
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
		return // duplicate (idempotent) or a blip — either way, degrade
	}
	audit.SystemWrite(ctx, e.pool, input.OrgID, input.CreatedBy, "recovery.item.created", audit.Options{
		TargetType: "recovery-item", TargetID: itemID,
		Metadata: map[string]any{
			"deadLetterId": input.DeadLetterID, "severity": severity,
			"errorSignature": input.ErrorSignature, "workflowId": input.WorkflowID,
		},
	})
}
