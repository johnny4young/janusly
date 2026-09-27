//go:build integration

package engine

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// seedClaimedCampaignItem publishes a running one-item campaign and claims its item.
func seedClaimedCampaignItem(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string) (string, store.ReplayCampaignItem) {
	t.Helper()
	campaignID := "camp-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO replay_campaigns
		(id, org_id, name, cluster_signature, filter_json, pacing_ms, status, total_count, created_by, next_dispatch_at, started_at)
		VALUES ($1, $2, 'settle', 'sig', '{}', 0, 'running', 1, 'test', now(), now())`, campaignID, org); err != nil {
		t.Fatalf("campaign: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO replay_campaign_items
		(id, org_id, campaign_id, dead_letter_id, position) VALUES ($1, $2, $3, 'dl-1', 0)`,
		campaignID+"-item", org, campaignID); err != nil {
		t.Fatalf("item: %v", err)
	}
	item, err := store.New(pool).ClaimNextReplayCampaignItem(ctx, store.ClaimNextReplayCampaignItemParams{
		ClaimToken: pgtype.Text{String: "claim-" + org, Valid: true}, CampaignID: campaignID,
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	return campaignID, item
}

// A completion that runs the moment an item settles must already see it counted.
func TestSettledCampaignItemIsCountedBeforeCompletionCanSeeIt(t *testing.T) {
	ctx, pool, _, org := newHarness(t)
	campaignID, item := seedClaimedCampaignItem(t, ctx, pool, org)
	q := store.New(pool)

	settled, err := q.SettleReplayCampaignItem(ctx, store.SettleReplayCampaignItemParams{
		Status: "replayed", ID: item.ID, ClaimToken: item.ClaimToken,
	})
	if err != nil || settled != 1 {
		t.Fatalf("settle: rows=%d err=%v", settled, err)
	}
	completed, err := q.CompleteReplayCampaignIfExhausted(ctx, campaignID)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if completed.ReplayedCount != 1 || completed.FailedCount != 0 {
		t.Fatalf("completion saw replayed=%d failed=%d, want 1/0", completed.ReplayedCount, completed.FailedCount)
	}
}

// A settle whose claim was reclaimed changes nothing, so the item is counted once.
func TestLostCampaignClaimSettlesAndCountsNothing(t *testing.T) {
	ctx, pool, _, org := newHarness(t)
	campaignID, item := seedClaimedCampaignItem(t, ctx, pool, org)
	q := store.New(pool)

	settled, err := q.SettleReplayCampaignItem(ctx, store.SettleReplayCampaignItemParams{
		Status: "failed", Error: pgtype.Text{String: "late", Valid: true}, ID: item.ID,
		ClaimToken: pgtype.Text{String: "stale-" + org, Valid: true},
	})
	if err != nil || settled != 0 {
		t.Fatalf("stale settle: rows=%d err=%v", settled, err)
	}
	campaign, err := q.GetReplayCampaign(ctx, store.GetReplayCampaignParams{OrgID: org, ID: campaignID})
	if err != nil {
		t.Fatalf("read campaign: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM replay_campaign_items WHERE id = $1`, item.ID).Scan(&status); err != nil {
		t.Fatalf("read item: %v", err)
	}
	if campaign.ReplayedCount != 0 || campaign.FailedCount != 0 || status != "processing" {
		t.Fatalf("stale settle leaked: replayed=%d failed=%d item=%s", campaign.ReplayedCount, campaign.FailedCount, status)
	}
}

// A pump whose claim is reclaimed mid-replay leaves the item, its counters and
// its audit to the reclaimer.
func TestReplayCampaignStepYieldsALostClaim(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, deadLetterID, campaignID := "run-"+org, "dl-"+org, "camp-lost-"+org
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters (id, org_id, run_id, node_id, workflow_json, node_json, error_json)
		VALUES ($1, $2, $3, 'node', '{}', '{}', '{}')`, deadLetterID, org, runID); err != nil {
		t.Fatalf("dead letter: %v", err)
	}
	// Due before any other campaign, so the step claims this one.
	if _, err := pool.Exec(ctx, `INSERT INTO replay_campaigns
		(id, org_id, name, cluster_signature, filter_json, pacing_ms, status, total_count, created_by, next_dispatch_at, started_at)
		VALUES ($1, $2, 'lost claim', 'sig', '{}', 0, 'running', 1, 'test', now() - interval '1 day', now())`, campaignID, org); err != nil {
		t.Fatalf("campaign: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO replay_campaign_items
		(id, org_id, campaign_id, dead_letter_id, position) VALUES ($1, $2, $3, $4, 0)`,
		campaignID+"-item", org, campaignID, deadLetterID); err != nil {
		t.Fatalf("item: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE replay_campaigns SET status = 'cancelled' WHERE id = $1`, campaignID)
	})

	// Hold the run's completion lock so the replay blocks after the item claim.
	hold, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin hold: %v", err)
	}
	defer func() { _ = hold.Rollback(ctx) }()
	if err := store.New(hold).AcquireRunCompletionLock(ctx, runID); err != nil {
		t.Fatalf("hold lock: %v", err)
	}
	stepped := make(chan error, 1)
	go func() {
		_, err := eng.ProcessDueReplayCampaignStep(ctx)
		stepped <- err
	}()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE datname = current_database() AND pid <> pg_backend_pid()
			  AND wait_event_type = 'Lock' AND wait_event = 'advisory')`).Scan(&blocked); err != nil {
			t.Fatalf("lock probe: %v", err)
		}
		if blocked {
			break
		}
		select {
		case err := <-stepped:
			t.Fatalf("step finished before blocking on the replay: %v", err)
		case <-time.After(5 * time.Millisecond):
		}
	}
	// Another pump reclaims the item while this replay is still running.
	if _, err := pool.Exec(ctx, `UPDATE replay_campaign_items SET claim_token = 'reclaimed'
		WHERE id = $1 AND status = 'processing'`, campaignID+"-item"); err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if err := hold.Rollback(ctx); err != nil {
		t.Fatalf("release lock: %v", err)
	}
	if err := <-stepped; err != nil {
		t.Fatalf("step: %v", err)
	}

	var status string
	var replayed, failed, audits int
	if err := pool.QueryRow(ctx, `SELECT i.status, c.replayed_count, c.failed_count
		FROM replay_campaign_items i JOIN replay_campaigns c ON c.id = i.campaign_id
		WHERE i.id = $1`, campaignID+"-item").Scan(&status, &replayed, &failed); err != nil {
		t.Fatalf("read item: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action LIKE 'recovery.campaign.%'`, org).Scan(&audits); err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if status != "processing" || replayed != 0 || failed != 0 || audits != 0 {
		t.Fatalf("lost claim leaked: item=%s replayed=%d failed=%d audits=%d", status, replayed, failed, audits)
	}
}
