// Weekly operations digest: an opt-in tenant summary (run totals and
// open failures over the last 7 days) mailed to the organization's
// admins. Rides the hourly maintenance sweep; org_digest_state is a leased,
// resumable per-recipient batch, so partial provider failures neither skip a
// week nor duplicate recipients that already succeeded. Mail goes
// through the same guarded email.send chokepoint as workflow tool nodes
// — rate gate, usage telemetry, and the honest noop default included.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/johnny4young/janusly/internal/store"
)

const digestMaxRecipientsPerAttempt = 50

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
		leaseToken := e.newID()
		claimedToken, err := q.ClaimWeeklyDigest(ctx, store.ClaimWeeklyDigestParams{
			OrgID: orgID, LeaseToken: leaseToken,
		})
		if err != nil {
			if err != pgx.ErrNoRows && ctx.Err() == nil {
				logger.Error("weekly digest claim failed", "org", orgID, "error", err)
			}
			continue // not due yet, or another replica won the week
		}
		if err := e.sendWeeklyDigest(ctx, orgID, claimedToken); err != nil && ctx.Err() == nil {
			logger.Warn("weekly digest send failed", "org", orgID, "error", err)
		}
	}
}

func (e *Engine) sendWeeklyDigest(ctx context.Context, orgID, leaseToken string) error {
	q := store.New(e.pool)
	recipients, err := q.ListOrgAdminEmails(ctx, orgID)
	if err != nil {
		return e.retryWeeklyDigest(ctx, q, orgID, leaseToken, err)
	}
	delivered, err := q.GetClaimedWeeklyDigestRecipients(ctx, store.GetClaimedWeeklyDigestRecipientsParams{
		OrgID: orgID, LeaseToken: leaseToken,
	})
	if err != nil {
		return err
	}
	pending := make([]string, 0, len(recipients))
	for _, recipient := range recipients {
		if !slices.Contains(delivered, recipient) {
			pending = append(pending, recipient)
		}
	}
	remaining := 0
	if len(pending) > digestMaxRecipientsPerAttempt {
		remaining = len(pending) - digestMaxRecipientsPerAttempt
		pending = pending[:digestMaxRecipientsPerAttempt]
	}
	stats, err := q.GetWeeklyDigestStats(ctx, orgID)
	if err != nil {
		return e.retryWeeklyDigest(ctx, q, orgID, leaseToken, err)
	}
	total := int(stats.Succeeded) + int(stats.Failed)
	rate := 100
	if total > 0 {
		rate = int(stats.Succeeded) * 100 / total
	}
	body := fmt.Sprintf(
		"Janusly weekly digest\n\nLast 7 days:\n- Runs: %d (%d succeeded, %d failed, %d%% success)\n- Open failures awaiting recovery: %d\n\nOpen the Operations page for details. You receive this because your organization enabled the weekly digest (Settings > Organization > digest.weeklyEnabled).\n",
		total, stats.Succeeded, stats.Failed, rate, stats.OpenDeadLetters)
	var failures []string
	for _, to := range pending {
		if rows, renewErr := q.RenewWeeklyDigestLease(ctx, store.RenewWeeklyDigestLeaseParams{
			OrgID: orgID, LeaseToken: leaseToken,
		}); renewErr != nil || rows != 1 {
			return fmt.Errorf("renew weekly digest lease: rows=%d: %w", rows, renewErr)
		}
		envelope := e.ExecuteIntegrationTool(ctx, orgID, "", "email.send", map[string]any{
			"to": to, "subject": "Janusly weekly digest", "text": body,
			"metadata": map[string]any{"kind": "weekly_digest"},
		})
		if ok, _ := envelope["ok"].(bool); !ok {
			message, _ := envelope["error"].(string)
			failures = append(failures, fmt.Sprintf("%s: %s", to, message))
			continue
		}
		if rows, recordErr := q.RecordWeeklyDigestRecipient(ctx, store.RecordWeeklyDigestRecipientParams{
			OrgID: orgID, LeaseToken: leaseToken, Recipient: to,
		}); recordErr != nil || rows != 1 {
			return fmt.Errorf("record weekly digest recipient: rows=%d: %w", rows, recordErr)
		}
	}
	if len(failures) > 0 || remaining > 0 {
		reason := fmt.Sprintf("%d recipient(s) pending", len(failures)+remaining)
		return e.retryWeeklyDigest(ctx, q, orgID, leaseToken, fmt.Errorf("%s", reason))
	}
	rows, err := q.CompleteWeeklyDigest(ctx, store.CompleteWeeklyDigestParams{
		OrgID: orgID, LeaseToken: leaseToken,
	})
	if err != nil || rows != 1 {
		return fmt.Errorf("complete weekly digest: rows=%d: %w", rows, err)
	}
	return nil
}

func (e *Engine) retryWeeklyDigest(ctx context.Context, q *store.Queries, orgID, leaseToken string, cause error) error {
	rows, err := q.RetryWeeklyDigest(ctx, store.RetryWeeklyDigestParams{
		OrgID: orgID, LeaseToken: leaseToken, LastError: cause.Error(),
	})
	if err != nil || rows != 1 {
		return fmt.Errorf("retry weekly digest: rows=%d: %w (cause: %v)", rows, err, cause)
	}
	return cause
}
