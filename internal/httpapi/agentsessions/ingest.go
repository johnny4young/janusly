// Package agentsessions serves the hooks bridge: signed event ingest from
// agent clients that hold the report capability.
package agentsessions

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

// Event budgets have their own buckets so a busy session never spends the
// client's MCP tool budget.
var (
	clientBurst  = ratelimit.Options{Name: "agent.hooks.client.burst", Max: 100, Window: 10 * time.Second}
	clientMinute = ratelimit.Options{Name: "agent.hooks.client", Max: 600, Window: time.Minute}
	orgMinute    = ratelimit.Options{Name: "agent.hooks.org", Max: 3000, Window: time.Minute}
)

// IngestDeps are what the ingest handler needs.
type IngestDeps struct {
	Pool    *pgxpool.Pool
	Limiter *ratelimit.Limiter
	Logger  *slog.Logger
	NewID   func() string
	Now     func() time.Time
}

// Ingest handles POST /agent-sessions/events for an authenticated principal.
func Ingest(deps IngestDeps) func(http.ResponseWriter, *http.Request, *agentclient.Principal) {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, r *http.Request, principal *agentclient.Principal) {
		raw, at, ok := admit(w, r, principal, deps.Limiter, now, hookwire.MaxBodyBytes)
		if !ok {
			return
		}
		event, err := hookwire.Parse(raw, at)
		if err != nil {
			httpkit.WriteUnversioned(w, httpkit.Error(http.StatusBadRequest, "agent_session_invalid_event", err.Error(), nil))
			return
		}
		result, err := agentsession.Ingest(r.Context(), deps.Pool, principal, event, at, deps.NewID)
		switch {
		case errors.Is(err, agentsession.ErrLiveLimit):
			httpkit.WriteUnversioned(w, httpkit.Error(http.StatusTooManyRequests, "agent_session_limit", err.Error(), nil))
		case errors.Is(err, agentsession.ErrTruncated):
			httpkit.WriteUnversioned(w, httpkit.Error(http.StatusConflict, "agent_session_truncated", err.Error(), nil))
		case err != nil:
			logger.Error("agent session ingest failed", "error", err)
			httpkit.WriteUnversioned(w, httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		default:
			status, outcome := http.StatusAccepted, result.Outcome
			if result.Outcome == agentsession.OutcomeDuplicate {
				status, outcome = http.StatusOK, result.PriorOutcome
			}
			data := map[string]any{
				"accepted": true, "duplicate": result.Outcome == agentsession.OutcomeDuplicate,
				"outcome": outcome, "eventId": event.ID, "sessionId": result.SessionID,
			}
			// Tells the bridge to hold this call for a person's decision.
			if event.Type == hookwire.TypeToolRequested && agentclient.GateMatches(principal.GateTools, event.Data.Tool) {
				data["gate"], data["captureContent"] = true, principal.CaptureContent
			}
			httpkit.WriteUnversioned(w, httpkit.Result{Status: status, Data: data})
		}
	}
}

// admit runs what every signed agent request shares: the report capability,
// the hook buckets, a bounded body and the signature. A GET signs its path.
func admit(w http.ResponseWriter, r *http.Request, principal *agentclient.Principal, limiter *ratelimit.Limiter,
	now func() time.Time, maxBytes int64) ([]byte, time.Time, bool) {
	if !principal.Has(agentclient.CapabilityReport) {
		httpkit.WriteUnversioned(w, httpkit.Error(http.StatusForbidden, "agent_capability_missing",
			"this agent client lacks the report capability", nil))
		return nil, time.Time{}, false
	}
	if limited := enforce(r, limiter, principal); limited != nil {
		result := httpkit.Error(http.StatusTooManyRequests, "rate_limited", limited.Error(), nil)
		result.RetryAfterSec = limited.RetryAfterSec
		httpkit.WriteUnversioned(w, result)
		return nil, time.Time{}, false
	}
	raw, signed := []byte(nil), []byte(r.URL.Path)
	if r.Method != http.MethodGet {
		var ok bool
		if raw, ok = httpkit.ReadRawBody(w, r, maxBytes); !ok {
			return nil, time.Time{}, false
		}
		signed = raw
	}
	at := now()
	if !hookwire.Verify(r.Header.Get(hookwire.SignatureHeader), principal.HookSigningKey(), signed, at.Unix()) {
		httpkit.WriteUnversioned(w, httpkit.Error(http.StatusUnauthorized, "agent_session_invalid_signature",
			"invalid agent session event signature", nil))
		return nil, time.Time{}, false
	}
	return raw, at, true
}

func enforce(r *http.Request, limiter *ratelimit.Limiter, principal *agentclient.Principal) *ratelimit.LimitError {
	if limiter == nil {
		return nil
	}
	for _, bucket := range []struct {
		key  string
		opts ratelimit.Options
	}{
		{principal.ClientID, clientBurst}, {principal.ClientID, clientMinute}, {principal.OrgID, orgMinute},
	} {
		var limited *ratelimit.LimitError
		if errors.As(limiter.Enforce(r.Context(), bucket.key, bucket.opts), &limited) {
			return limited
		}
	}
	return nil
}
