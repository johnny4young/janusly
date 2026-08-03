// Paced replay-campaign pump. The reference drains campaigns through
// delayed queue jobs with the Postgres due clock as the authority and a
// reconciler repairing lost publications; the pilot pumps that same due
// clock directly — no queue mirror to repair. Invariants preserved:
// one step performs at most one replay (pacing is never a loop sleep),
// the dispatch claim pushes the clock forward atomically so concurrent
// pumps can't double-dispatch, item leases carry a claim token, and
// cancellation stops new claims while an in-flight item finishes
// truthfully.
package engine

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/store"
)

// The campaign pump's audit actions exist in the reference too, but are
// written by its UNTYPED system writer (deps.audit in replay-campaign.ts),
// so they sit outside the typed AuditAction catalog the pilot extracted —
// they register here rather than counting against the reference pin.
func init() {
	audit.RegisterPilotAction("recovery.campaign.completed")
	audit.RegisterPilotAction("recovery.campaign.item_replayed")
	audit.RegisterPilotAction("recovery.campaign.item_failed")
}

// campaignSystemActor mirrors the reference's completion-audit actor.
const campaignSystemActor = "system:replay-campaign"

func (e *Engine) auditCampaignCompleted(ctx context.Context, campaign store.ReplayCampaign) {
	audit.SystemWrite(ctx, e.pool, campaign.OrgID, campaignSystemActor,
		"recovery.campaign.completed", audit.Options{
			TargetType: "replay_campaign", TargetID: campaign.ID,
			Metadata: map[string]any{
				"replayed": campaign.ReplayedCount, "failed": campaign.FailedCount,
				"cancelled": campaign.CancelledCount,
			},
		})
}

// ProcessDueReplayCampaignStep claims ONE due running campaign and drains
// at most one item. Returns false when nothing was due.
func (e *Engine) ProcessDueReplayCampaignStep(ctx context.Context) (bool, error) {
	q := store.New(e.pool)
	campaign, err := q.ClaimDueReplayCampaign(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}

	claimToken := e.newID()
	item, err := q.ClaimNextReplayCampaignItem(ctx, store.ClaimNextReplayCampaignItemParams{
		ClaimToken: pgtype.Text{String: claimToken, Valid: true},
		CampaignID: campaign.ID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No pending work: complete the campaign if nothing is in flight.
			completed, err := q.CompleteReplayCampaignIfExhausted(ctx, campaign.ID)
			if err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					return true, err
				}
				return true, nil
			}
			e.auditCampaignCompleted(ctx, completed)
			return true, nil
		}
		return true, err
	}

	// Per-item fault isolation: a failed replay settles the item and moves
	// on; it never wedges the campaign.
	var itemError pgtype.Text
	status := "replayed"
	if err := e.RedriveDeadLetter(ctx, campaign.OrgID, item.DeadLetterID); err != nil {
		status = "failed"
		itemError = pgtype.Text{String: err.Error(), Valid: true}
	}
	if _, err := q.SettleReplayCampaignItem(ctx, store.SettleReplayCampaignItemParams{
		Status: status, Error: itemError, ID: item.ID,
		ClaimToken: pgtype.Text{String: claimToken, Valid: true},
	}); err != nil {
		return true, err
	}
	itemAction := audit.Action("recovery.campaign.item_replayed")
	itemMetadata := map[string]any{"campaignId": campaign.ID, "position": item.Position}
	if status == "failed" {
		itemAction = "recovery.campaign.item_failed"
		itemMetadata["error"] = itemError.String
	}
	audit.SystemWrite(ctx, e.pool, campaign.OrgID, campaign.CreatedBy, itemAction, audit.Options{
		TargetType: "dlq", TargetID: item.DeadLetterID, Metadata: itemMetadata,
	})
	replayed, failed := int32(0), int32(0)
	if status == "replayed" {
		replayed = 1
	} else {
		failed = 1
	}
	if err := q.BumpReplayCampaignCounter(ctx, store.BumpReplayCampaignCounterParams{
		Replayed: replayed, Failed: failed, ID: campaign.ID,
	}); err != nil {
		return true, err
	}
	// A drained cohort completes without waiting one extra pacing period.
	completed, err := q.CompleteReplayCampaignIfExhausted(ctx, campaign.ID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return true, err
		}
		return true, nil
	}
	e.auditCampaignCompleted(ctx, completed)
	return true, nil
}

// RunReplayCampaignPump polls the due clock until the context ends. The
// poll only bounds how quickly a newly due campaign is noticed; pacing
// itself lives in the dispatch claim.
func (e *Engine) RunReplayCampaignPump(ctx context.Context, poll time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		for {
			dispatched, err := e.ProcessDueReplayCampaignStep(ctx)
			if err != nil {
				if ctx.Err() == nil {
					logger.Error("replay campaign step failed", "error", err)
				}
				break
			}
			if !dispatched {
				break
			}
		}
	}
}
