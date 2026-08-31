package operations

import (
	"context"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

type Builder struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func (b Builder) Build(ctx context.Context, orgID string, permissions map[string]bool) Brief {
	now := time.Now().UTC()
	if b.Now != nil {
		now = b.Now().UTC()
	}
	brief := Brief{
		Version: "1", GeneratedAt: now.Format(time.RFC3339Nano),
		Actions: []Action{}, Warnings: []string{},
	}
	if b.Pool == nil || orgID == "" {
		brief.Warnings = append(brief.Warnings, "operator_brief_store_unavailable")
		return brief
	}

	var candidates []rankedAction
	q := store.New(b.Pool)
	if permissions["recovery.read"] {
		cases, err := q.ListRecoveryCases(ctx, store.ListRecoveryCasesParams{
			OrgID: orgID, OpenOnly: false, PageLimit: 200,
		})
		if err != nil {
			brief.Warnings = append(brief.Warnings, "recovery_cases_unavailable")
		} else {
			candidates = append(candidates, recoveryCaseActions(cases, permissions, now)...)
		}
	}

	if permissions["runs.read"] {
		approvals, err := b.pendingApprovals(ctx, orgID)
		if err != nil {
			brief.Warnings = append(brief.Warnings, "run_approvals_unavailable")
		} else {
			for _, approval := range approvals {
				candidates = append(candidates, runApprovalAction(approval, permissions))
			}
		}
	}

	clusters, clusterWarnings := b.failureClusters(
		ctx, orgID, now,
		permissions["dlq.read"], permissions["runs.read"], permissions["recovery.read"],
	)
	brief.Warnings = append(brief.Warnings, clusterWarnings...)
	clusterDeadLetters := map[string]bool{}
	for _, cluster := range clusters {
		if cluster.Frequency < 2 {
			continue
		}
		candidates = append(candidates, clusterAction(cluster, permissions))
		for _, sample := range cluster.Samples {
			if sample.Source == "dead_letter" {
				clusterDeadLetters[sample.ID] = true
			}
		}
	}

	if permissions["dlq.read"] {
		deadLetters, err := q.ListDeadLetterSummaries(ctx, store.ListDeadLetterSummariesParams{
			OrgID: orgID, FilterStatus: pgtype.Text{String: "open", Valid: true},
			PageLimit: maxSourceRows,
		})
		if err != nil {
			brief.Warnings = append(brief.Warnings, "dead_letters_unavailable")
		} else {
			for _, row := range deadLetters {
				if clusterDeadLetters[row.ID] {
					continue
				}
				candidates = append(candidates, deadLetterAction(row, permissions))
			}
		}
	}

	brief.Actions = rankActions(candidates)
	sort.Strings(brief.Warnings)
	return brief
}
