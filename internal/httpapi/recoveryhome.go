// Coalesced Home read model — GET /recovery/home. Each section settles
// independently ({status: "ok", value} | {status: "unavailable"}) so one
// unavailable projection never erases healthy recovery data. The full
// scope replaces the landing page's initial request burst; the impact
// scope keeps the lightweight convergence poll to one request.
package httpapi

import (
	"context"

	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

func settleSection(sections map[string]any, name string, loader func() (any, error)) {
	value, err := loader()
	if err != nil {
		sections[name] = map[string]any{"status": "unavailable"}
		return
	}
	sections[name] = map[string]any{"status": "ok", "value": value}
}

// deadLetterCountsValue is the org-wide status breakdown for the queue
// mini-grid (whole-queue health, never scoped by the operator's filter).
func (s *V1Server) deadLetterCountsValue(ctx context.Context, orgID string) (map[string]any, error) {
	counts, err := store.New(s.pool).CountDeadLettersByStatus(ctx, orgID)
	if err != nil {
		return nil, err
	}
	totals := map[string]any{"total": int64(0), "open": int64(0), "replayed": int64(0), "resolved": int64(0)}
	total := int64(0)
	for _, row := range counts {
		total += row.Count
		if _, known := totals[row.Status]; known {
			totals[row.Status] = row.Count
		}
	}
	totals["total"] = total
	return totals, nil
}

func (s *V1Server) queueOverviewValue(ctx context.Context, orgID string) (any, error) {
	counts, err := s.deadLetterCountsValue(ctx, orgID)
	if err != nil {
		return nil, err
	}
	oldest, err := s.listRecoveryQueue(ctx, orgID, recoveryQueueQuery{
		status: "open", sort: "oldest", limit: 1,
	})
	if err != nil {
		return nil, err
	}
	var oldestOpen any
	if len(oldest) > 0 {
		oldestOpen = oldest[0].view
	}
	return map[string]any{"counts": counts, "oldestOpen": oldestOpen}, nil
}

// impactSections: ledger + operator wins + queue overview — the cheap
// convergence poll.
func (s *V1Server) impactSections(ctx context.Context, rc v1Request, sections map[string]any) {
	q := store.New(s.pool)
	settleSection(sections, "ledger", func() (any, error) {
		rollup, err := q.GetRecoveryImpactRollup(ctx, rc.orgID)
		if err != nil {
			// No rollup row yet = a zero ledger, not an outage.
			return map[string]any{"totalRecovered": 0, "downtimeEndedMs": 0, "sinceIso": nil}, nil
		}
		var sinceIso any
		if rollup.FirstRecoveredAt != nil {
			sinceIso = rollup.FirstRecoveredAt.UTC()
		}
		return map[string]any{
			"totalRecovered": rollup.TotalRecovered, "downtimeEndedMs": rollup.DowntimeEndedMs,
			"sinceIso": sinceIso,
		}, nil
	})
	settleSection(sections, "wins", func() (any, error) {
		since := time.Now().UTC().AddDate(0, 0, -30)
		recovered, err := q.QueryOperatorRecoveryCount(ctx, store.QueryOperatorRecoveryCountParams{
			OrgID: rc.orgID, UserID: pgtype.Text{String: rc.userID, Valid: rc.userID != ""}, RecoveredAt: since,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"recovered": recovered, "windowDays": 30}, nil
	})
	settleSection(sections, "queue", func() (any, error) {
		return s.queueOverviewValue(ctx, rc.orgID)
	})
}

func (s *V1Server) recoveryHomeCore(r *http.Request, rc v1Request) opResult {
	ctx := r.Context()
	scope := "full"
	if r.URL.Query().Get("scope") == "impact" {
		scope = "impact"
	}
	sections := map[string]any{}
	s.impactSections(ctx, rc, sections)
	if scope == "full" {
		q := store.New(s.pool)
		settleSection(sections, "metrics", func() (any, error) {
			return s.recoveryMetricsValue(ctx, rc.orgID, 30)
		})
		settleSection(sections, "clusters", func() (any, error) {
			return s.failureClustersValue(ctx, rc.orgID, 30)
		})
		settleSection(sections, "heatmap", func() (any, error) {
			since := time.Now().UTC().AddDate(0, 0, -90)
			rows, err := q.QueryRecoveryHeatmap(ctx, store.QueryRecoveryHeatmapParams{
				OrgID: rc.orgID, CreatedAt: &since,
			})
			if err != nil {
				return nil, err
			}
			days := make([]map[string]any, 0, len(rows))
			for _, row := range rows {
				days = append(days, map[string]any{
					"day": row.Day, "failures": row.Failures, "recovered": row.Recovered,
					"mttrSeconds": int(row.MttrSeconds + 0.5),
				})
			}
			return map[string]any{"days": days, "windowDays": 90}, nil
		})
		settleSection(sections, "cases", func() (any, error) {
			rows, err := q.ListRecoveryCases(ctx, store.ListRecoveryCasesParams{
				OrgID: rc.orgID, OpenOnly: true, PageLimit: 50,
			})
			if err != nil {
				return nil, err
			}
			cases := make([]map[string]any, 0, len(rows))
			for _, row := range rows {
				cases = append(cases, map[string]any{
					"id": row.ID, "runId": row.RunID, "workflowId": textOrNull(row.WorkflowID),
					"source": row.Source, "detectorId": row.DetectorID, "detectorKind": row.DetectorKind,
					"action": row.Action, "state": row.State, "message": row.Message,
					"createdAt": row.CreatedAt,
				})
			}
			return map[string]any{"cases": cases}, nil
		})
		// Controlled-drill evidence shares the exact report builder and one
		// bounded SQL projection with the focused API and exports.
		settleSection(sections, "validation", func() (any, error) {
			return s.queryRecoveryValidation(ctx, rc.orgID, 30, time.Now().UTC())
		})
	}
	return opOK(map[string]any{
		"scope":       scope,
		"generatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"sections":    sections,
	})
}

func (s *V1Server) mountRecoveryHomeRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /recovery/home", routeGate{auth.RoleViewer, "recovery.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryHomeCore(r, rc))
	})
}
