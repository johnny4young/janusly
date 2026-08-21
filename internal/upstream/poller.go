// Background poller for upstream status feeds (reference
// the source contract). A single sweep visits
// every ENABLED source across all orgs on a fixed tick; per source it
// checks whether checkIntervalSeconds has elapsed, fetches the feed
// through the SSRF chokepoint, parses via the PURE feed helpers, and acts:
//
//	DEGRADED  → pause every workflow tagged with the source's name
//	            (workflows.status = paused_upstream_degraded), audit
//	            `workflow.paused.upstream` once per actual flip.
//	RECOVERED → resume the workflows this source had paused, audit
//	            `workflow.resumed.upstream` once per actual flip.
//
// FAIL-OPEN is the load-bearing safety property: a feed that is
// unreachable, times out, returns non-JSON, or is missing the watched
// component does NOT pause anything — an unreachable status page must
// never amplify an outage. The fail-open poll records lastErrorReason for
// visibility but leaves the derived status (and the pause state)
// UNCHANGED. The sweep never throws; the next tick is the natural retry.
package upstream

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	feedMaxBytes  = 256 * 1024
	feedTimeoutMs = 10_000
)

// Fetcher is the injectable network seam (tests drive parse/pause logic
// without the network). Default: the guarded FetchHTTPTarget GET.
type Fetcher func(ctx context.Context, url string) (statusCode int, body string, err error)

// DefaultFetcher rides the SSRF chokepoint.
func DefaultFetcher(ctx context.Context, url string) (int, string, error) {
	result, err := executors.FetchHTTPTarget(ctx, url, executors.FetchOptions{
		Method: "GET", TimeoutMs: feedTimeoutMs, MaxResponseBytes: feedMaxBytes,
	})
	if err != nil {
		return 0, "", err
	}
	return result.StatusCode, result.Body, nil
}

// PollOutcome reports one source poll for the Check-now route + tests.
type PollOutcome struct {
	Parse              ParseResult
	PausedWorkflowIDs  []string
	ResumedWorkflowIDs []string
	FailedOpen         bool
}

// ExpectedComponents decodes the jsonb tag list leniently.
func ExpectedComponents(raw json.RawMessage) []string {
	var components []string
	_ = json.Unmarshal(raw, &components)
	return components
}

func systemActor(orgID string) *auth.Context {
	return &auth.Context{OrgID: orgID, UserID: "system:upstream-health"}
}

// PollOneSource: fetch → parse → record → pause/resume tagged workflows.
// NEVER returns an error for feed problems — those are fail-open results.
func PollOneSource(ctx context.Context, pool *pgxpool.Pool, source store.UpstreamHealthSource, fetch Fetcher) PollOutcome {
	q := store.New(pool)
	expected := ExpectedComponents(source.ExpectedComponents)

	statusCode, body, err := fetch(ctx, source.Url)
	var parse ParseResult
	if err != nil {
		// FAIL-OPEN: unreachable / timed-out feed.
		_ = q.RecordUpstreamPollError(ctx, store.RecordUpstreamPollErrorParams{
			OrgID: source.OrgID, ID: source.ID,
			LastErrorReason: pgtype.Text{String: "unreachable", Valid: true},
		})
		return PollOutcome{Parse: failOpen("unparseable"), FailedOpen: true}
	}
	if source.Kind == "http_probe" {
		parse = ParseFeed(source.Kind, expected, nil, statusCode)
	} else {
		var document any
		_ = json.Unmarshal([]byte(body), &document)
		parse = ParseFeed(source.Kind, expected, document, statusCode)
	}
	if !parse.OK {
		// FAIL-OPEN: unparseable / missing component. Record the reason;
		// lastStatus/lastDegraded stay unchanged, nothing pauses.
		_ = q.RecordUpstreamPollError(ctx, store.RecordUpstreamPollErrorParams{
			OrgID: source.OrgID, ID: source.ID,
			LastErrorReason: pgtype.Text{String: parse.Reason, Valid: true},
		})
		return PollOutcome{Parse: parse, FailedOpen: true}
	}

	_ = q.RecordUpstreamStatus(ctx, store.RecordUpstreamStatusParams{
		OrgID: source.OrgID, ID: source.ID,
		LastStatus:   pgtype.Text{String: parse.Status, Valid: true},
		LastDegraded: parse.Degraded,
	})

	tagged := listTaggedWorkflowIDs(ctx, q, source.OrgID, source.Name)
	if len(tagged) == 0 {
		return PollOutcome{Parse: parse}
	}

	if parse.Degraded {
		paused, err := q.PauseWorkflowsForUpstream(ctx, store.PauseWorkflowsForUpstreamParams{
			OrgID: source.OrgID, Column2: tagged,
			PausedReason: pgtype.Text{String: "Upstream \"" + source.Name + "\" degraded (" + parse.Status + ")", Valid: true},
		})
		if err != nil {
			return PollOutcome{Parse: parse}
		}
		for _, workflowID := range paused {
			audit.Write(ctx, pool, systemActor(source.OrgID), "workflow.paused.upstream", audit.Options{
				TargetType: "workflow", TargetID: workflowID,
				Metadata: map[string]any{
					"sourceName": source.Name, "sourceKind": source.Kind,
					"status": parse.Status, "components": parse.Components,
				},
			})
		}
		return PollOutcome{Parse: parse, PausedWorkflowIDs: paused}
	}

	resumed, err := q.ResumeWorkflowsForUpstream(ctx, store.ResumeWorkflowsForUpstreamParams{
		OrgID: source.OrgID, Column2: tagged,
	})
	if err != nil {
		return PollOutcome{Parse: parse}
	}
	for _, workflowID := range resumed {
		audit.Write(ctx, pool, systemActor(source.OrgID), "workflow.resumed.upstream", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{
				"sourceName": source.Name, "sourceKind": source.Kind, "status": parse.Status,
			},
		})
	}
	return PollOutcome{Parse: parse, ResumedWorkflowIDs: resumed}
}

// listTaggedWorkflowIDs reads the LATEST version's tag set per workflow —
// only the current tags decide subscription.
func listTaggedWorkflowIDs(ctx context.Context, q *store.Queries, orgID, sourceName string) []string {
	rows, err := q.ListLatestWorkflowVersionUpstreamTags(ctx, orgID)
	if err != nil {
		return nil
	}
	var matched []string
	for _, row := range rows {
		if slices.Contains(ExpectedComponents(row.UpstreamHealthSources), sourceName) {
			matched = append(matched, row.WorkflowID)
		}
	}
	return matched
}

// upstreamSweepLimit bounds one sweep; the next tick picks up the rest.
const upstreamSweepLimit = 200

// Sweep polls every enabled + due source; one bad source never stalls the
// rest.
func Sweep(ctx context.Context, pool *pgxpool.Pool, fetch Fetcher, logger *slog.Logger) {
	// Claiming stamps the clock, so a concurrent replica's sweep no longer
	// sees these sources as due: one probe per interval, not one per
	// replica, against third-party status pages that rate-limit.
	sources, err := store.New(pool).ClaimDueUpstreamHealthSources(ctx, upstreamSweepLimit)
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("upstream-health: failed to claim sources", "error", err)
		}
		return
	}
	for _, source := range sources {
		PollOneSource(ctx, pool, source, fetch)
	}
}

// RunSweep loops the sweep on an interval until the context ends (wired
// from the API binary next to the retention sweep).
func RunSweep(ctx context.Context, pool *pgxpool.Pool, every time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		Sweep(ctx, pool, DefaultFetcher, logger)
	}
}
