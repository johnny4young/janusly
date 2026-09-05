// Public workflow status pages.
//
// An org admin mints one opaque token per workflow; the resulting
// /public/status/{token} page is readable without authentication. The
// row IS the enablement: rotating replaces the token (old links die),
// deleting revokes the page. The public payload is deliberately minimal
// — workflow name, verdict, seven daily aggregate bars, last success —
// and never carries run ids, node internals, or error text, because
// those can quote tenant data. Lookups by unknown token answer a uniform
// 404 with no tenant signal.
package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/johnny4young/janusly/internal/ratelimit"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

func init() {
	audit.RegisterRuntimeAction("workflow.status_page.rotated")
	audit.RegisterRuntimeAction("workflow.status_page.revoked")
}

func (s *V1Server) mountStatusPageRoutes(mux *http.ServeMux) {
	adminGate := routeGate{auth.RoleAdmin, "org.config.write"}

	s.route(mux, "GET /workflows/{workflowId}/status-page", adminGate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		row, err := store.New(s.pool).GetWorkflowStatusPage(r.Context(), store.GetWorkflowStatusPageParams{
			OrgID: rc.orgID, WorkflowID: workflowID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			writeUnversioned(w, opOK(map[string]any{"enabled": false}))
			return
		}
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		// Public tokens are one-time reveal values. Only the digest is stored,
		// so an existing page can be managed but its bearer URL cannot be
		// reconstructed after the mint response.
		writeUnversioned(w, opOK(statusPageAdminView("", row)))
	})

	s.route(mux, "POST /workflows/{workflowId}/status-page", adminGate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		token := hex.EncodeToString(raw)
		if err := store.New(s.pool).UpsertWorkflowStatusPage(r.Context(), store.UpsertWorkflowStatusPageParams{
			OrgID: rc.orgID, WorkflowID: workflowID, TokenDigest: statusPageTokenDigest(token),
		}); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		s.statusPages.forget(workflowID)
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.status_page.rotated", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
		})
		writeUnversioned(w, opOK(statusPageAdminView(token, time.Now().UTC())))
	})

	s.route(mux, "DELETE /workflows/{workflowId}/status-page", adminGate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		revoked, err := store.New(s.pool).DeleteWorkflowStatusPage(r.Context(), store.DeleteWorkflowStatusPageParams{
			OrgID: rc.orgID, WorkflowID: workflowID,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		s.statusPages.forget(workflowID)
		if revoked > 0 {
			audit.Write(r.Context(), s.pool, rc.authContext, "workflow.status_page.revoked", audit.Options{
				TargetType: "workflow", TargetID: workflowID,
			})
		}
		writeUnversioned(w, opOK(map[string]any{"enabled": false}))
	})

	// Public, unauthenticated by design (like the SSO start/callback pair):
	// authorization is possession of the unguessable 256-bit token.
	mux.HandleFunc("GET /public/status/{token}", s.servePublicStatusPage)
}

func statusPageAdminView(token string, createdAt time.Time) map[string]any {
	view := map[string]any{
		"enabled": true, "createdAt": createdAt.UTC().Format(time.RFC3339),
	}
	if token != "" {
		view["token"] = token
		view["path"] = "/public/status/" + token
	}
	return view
}

func statusPageTokenDigest(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

// The public page is unauthenticated and costs three queries, one of them an
// aggregate over runs. A leaked or widely shared token must not become a
// load generator against the API pool: reads are metered per client address
// and the rendered inputs are cached for the same 60s the browser is told.
var publicStatusPageLimit = ratelimit.Options{Name: "public:status-page", Max: 60, Window: time.Minute}

const statusPageCacheTTL = 60 * time.Second

type statusPageSnapshot struct {
	page           store.FindWorkflowStatusPageByTokenDigestRow
	days           []store.ListStatusPageDailyStatsRow
	lastSuccess    time.Time
	lastSuccessErr error
	at             time.Time
}

type statusPageCache struct {
	mu      sync.Mutex
	entries map[string]statusPageSnapshot
}

func (c *statusPageCache) get(digest string) (statusPageSnapshot, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[digest]
	if !ok || time.Since(entry.at) > statusPageCacheTTL {
		return statusPageSnapshot{}, false
	}
	return entry, true
}

// forget drops every snapshot for a workflow so a rotated or revoked token
// dies immediately instead of at the end of its cache window.
func (c *statusPageCache) forget(workflowID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, existing := range c.entries {
		if existing.page.WorkflowID == workflowID {
			delete(c.entries, key)
		}
	}
}

func (c *statusPageCache) put(digest string, entry statusPageSnapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]statusPageSnapshot{}
	}
	// Bound the map: tokens are 32 random bytes, so entries only accumulate
	// through real traffic; expired ones are dropped on the way in.
	for key, existing := range c.entries {
		if time.Since(existing.at) > statusPageCacheTTL {
			delete(c.entries, key)
		}
	}
	c.entries[digest] = entry
}

func (s *V1Server) loadStatusPage(ctx context.Context, digest string) (statusPageSnapshot, error) {
	if entry, ok := s.statusPages.get(digest); ok {
		return entry, nil
	}
	q := store.New(s.pool)
	page, err := q.FindWorkflowStatusPageByTokenDigest(ctx, digest)
	if err != nil {
		return statusPageSnapshot{}, err
	}
	days, err := q.ListStatusPageDailyStats(ctx, store.ListStatusPageDailyStatsParams{
		OrgID: page.OrgID, WorkflowID: page.WorkflowID,
	})
	if err != nil {
		return statusPageSnapshot{}, errStatusPageUnavailable
	}
	// max() over zero successes is NULL; the scan error is the "never
	// succeeded" case and keeps the dash label.
	lastSuccess, lastSuccessErr := q.GetStatusPageLastSuccess(ctx, store.GetStatusPageLastSuccessParams{
		OrgID: page.OrgID, WorkflowID: page.WorkflowID,
	})
	entry := statusPageSnapshot{page: page, days: days, lastSuccess: lastSuccess, lastSuccessErr: lastSuccessErr, at: time.Now()}
	s.statusPages.put(digest, entry)
	return entry, nil
}

var errStatusPageUnavailable = errors.New("status page stats unavailable")

func (s *V1Server) servePublicStatusPage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	// Cheap shape gate before touching the database.
	if len(token) != 64 || strings.Trim(token, "0123456789abcdef") != "" {
		http.NotFound(w, r)
		return
	}
	if err := s.limiter.Enforce(r.Context(), "ip:"+clientAddress(r), publicStatusPageLimit); err != nil {
		var limited *ratelimit.LimitError
		if errors.As(err, &limited) {
			w.Header().Set("Retry-After", strconv.Itoa(limited.RetryAfterSec))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	snapshot, err := s.loadStatusPage(r.Context(), statusPageTokenDigest(token))
	if errors.Is(err, errStatusPageUnavailable) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	page, days, lastSuccess, lastSuccessErr := snapshot.page, snapshot.days, snapshot.lastSuccess, snapshot.lastSuccessErr

	succeeded, failed := 0, 0
	for _, day := range days {
		succeeded += int(day.Succeeded)
		failed += int(day.Failed)
	}
	verdict, tone := "Operational", "#16a34a"
	switch {
	case succeeded+failed == 0:
		verdict, tone = "No recent runs", "#64748b"
	case failed > 0 && succeeded == 0:
		verdict, tone = "Failing", "#dc2626"
	case failed > 0:
		verdict, tone = "Degraded", "#d97706"
	}

	var bars strings.Builder
	for _, day := range days {
		total := day.Succeeded + day.Failed
		rate := 0
		if total > 0 {
			rate = int(day.Succeeded) * 100 / int(total)
		}
		barTone := "#16a34a"
		if day.Failed > 0 {
			barTone = "#d97706"
		}
		if day.Succeeded == 0 && day.Failed > 0 {
			barTone = "#dc2626"
		}
		fmt.Fprintf(&bars,
			`<div class="day" title="%s: %d ok / %d failed"><div class="bar" style="height:%d%%;background:%s"></div><span>%s</span></div>`,
			day.Day.Format("Jan 2"), day.Succeeded, day.Failed, max(rate, 6), barTone, day.Day.Format("01/02"))
	}
	lastSuccessLabel := "—"
	if lastSuccessErr == nil && !lastSuccess.IsZero() {
		lastSuccessLabel = lastSuccess.UTC().Format("2006-01-02 15:04 UTC")
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex")
	_, _ = fmt.Fprintf(w, publicStatusPageHTML,
		html.EscapeString(page.WorkflowName), tone, html.EscapeString(verdict),
		html.EscapeString(page.WorkflowName), succeeded+failed, succeeded,
		html.EscapeString(lastSuccessLabel), bars.String())
}

const publicStatusPageHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>%s — status</title>
<style>
  body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f8fafc;color:#0f172a;
       display:grid;place-items:center;min-height:100vh}
  main{width:min(560px,92vw);background:#fff;border:1px solid #e2e8f0;border-radius:14px;
       padding:28px 32px;box-shadow:0 1px 3px rgba(15,23,42,.06)}
  .verdict{display:inline-flex;align-items:center;gap:8px;font-weight:600;color:%s}
  .verdict::before{content:"";width:10px;height:10px;border-radius:50%%;background:currentColor}
  h1{font-size:19px;margin:6px 0 18px}
  dl{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:0 0 20px}
  dt{font-size:12px;color:#64748b}dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
  .days{display:flex;gap:8px;align-items:flex-end;height:74px}
  .day{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%%}
  .day .bar{width:100%%;border-radius:4px 4px 0 0;min-height:4px}
  .day span{font-size:10px;color:#94a3b8}
  footer{margin-top:22px;font-size:12px;color:#94a3b8}
</style></head><body><main>
<span class="verdict">%s</span>
<h1>%s</h1>
<dl>
  <div><dt>Runs (7 days)</dt><dd>%d</dd></div>
  <div><dt>Succeeded</dt><dd>%d</dd></div>
  <div><dt>Last success</dt><dd>%s</dd></div>
</dl>
<div class="days">%s</div>
<footer>Powered by Janusly</footer>
</main></body></html>
`
