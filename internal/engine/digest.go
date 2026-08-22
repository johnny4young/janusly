// Weekly operations digest: an opt-in tenant summary (run totals and
// open failures over the last 7 days) mailed to the organization's
// admins. Rides the hourly maintenance sweep; the org_digest_state row
// is a multi-replica claim (the upsert only wins when the last send is
// ≥ a week old), so competing replicas cannot double-send. Mail goes
// through the same guarded email.send chokepoint as workflow tool nodes
// — rate gate, usage telemetry, and the honest noop default included.
package engine

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/johnny4young/janusly/internal/store"
)

const digestMaxRecipients = 10

func (e *Engine) processWeeklyDigests(ctx context.Context, logger *slog.Logger) {
	q := store.New(e.pool)
	orgs, err := q.ListWeeklyDigestOptIns(ctx)
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("weekly digest opt-in listing failed", "error", err)
		}
		return
	}
	for _, orgID := range orgs {
		claimed, err := q.ClaimWeeklyDigest(ctx, orgID)
		if err != nil || claimed == 0 {
			continue // not due yet, or another replica won the week
		}
		if err := e.sendWeeklyDigest(ctx, orgID); err != nil && ctx.Err() == nil {
			// The claim already advanced: a failed send skips the week
			// rather than retry-storming a broken mailer every hour.
			logger.Warn("weekly digest send failed", "org", orgID, "error", err)
		}
	}
}

func (e *Engine) sendWeeklyDigest(ctx context.Context, orgID string) error {
	q := store.New(e.pool)
	recipients, err := q.ListOrgAdminEmails(ctx, orgID)
	if err != nil {
		return err
	}
	if len(recipients) == 0 {
		return nil // opted in with no admin addresses: nothing to send
	}
	if len(recipients) > digestMaxRecipients {
		recipients = recipients[:digestMaxRecipients]
	}
	stats, err := q.GetWeeklyDigestStats(ctx, orgID)
	if err != nil {
		return err
	}
	total := int(stats.Succeeded) + int(stats.Failed)
	rate := 100
	if total > 0 {
		rate = int(stats.Succeeded) * 100 / total
	}
	body := fmt.Sprintf(
		"Janusly weekly digest\n\nLast 7 days:\n- Runs: %d (%d succeeded, %d failed, %d%% success)\n- Open failures awaiting recovery: %d\n\nOpen the Operations page for details. You receive this because your organization enabled the weekly digest (Settings > Organization > digest.weeklyEnabled).\n",
		total, stats.Succeeded, stats.Failed, rate, stats.OpenDeadLetters)
	var lastError error
	for _, to := range recipients {
		envelope := e.ExecuteIntegrationTool(ctx, orgID, "", "email.send", map[string]any{
			"to": to, "subject": "Janusly weekly digest", "text": body,
			"metadata": map[string]any{"kind": "weekly_digest"},
		})
		if ok, _ := envelope["ok"].(bool); !ok {
			message, _ := envelope["error"].(string)
			lastError = fmt.Errorf("email.send: %s", message)
		}
	}
	return lastError
}
