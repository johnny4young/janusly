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
	// Surface projects the shared, permission-aware business actions onto the
	// actual executable catalog returned to the authenticated transport.
	Surface ActionSurface
	// HumanApproval reports whether the authenticated transport can create a
	// recovery approval grant. Service-token/MCP principals may consume an
	// independently created grant through apply, but must never be told that
	// approval itself is an allowed action.
	HumanApproval bool
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
		cases, err := q.ListOperatorBriefRecoveryCases(ctx, store.ListOperatorBriefRecoveryCasesParams{
			OrgID: orgID, RecurrenceSince: now.AddDate(0, 0, -30), PageLimit: maxSourceRows,
		})
		if err != nil {
			brief.Warnings = append(brief.Warnings, "recovery_cases_unavailable")
		} else {
			candidates = append(candidates, recoveryCaseActions(cases, permissions, now, b.HumanApproval)...)
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
	for index := range brief.Actions {
		brief.Actions[index].AllowedActions = projectAllowedActions(
			b.Surface,
			brief.Actions[index].AllowedActions,
		)
	}
	sort.Strings(brief.Warnings)
	return brief
}
