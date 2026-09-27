//go:build integration

package engine

import (
	"context"
	"testing"

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
