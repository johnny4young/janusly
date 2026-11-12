package agentsessions

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

const gateDecidedAction = "agent_gate.decided"

func init() { audit.RegisterRuntimeAction(gateDecidedAction) }

// SecondPersonKey is the organization switch that also stops an agent
// client's creator from deciding its gates.
const SecondPersonKey = "agents.publishRequiresSecondPerson"

const gatePollInterval = time.Second

// pollSlots bounds the long polls one client holds open in this process, so
// polling costs at most that many queries a second per client.
type pollSlots struct {
	mu   sync.Mutex
	held map[string]int
}

func (p *pollSlots) take(clientID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held[clientID] >= agentsession.MaxOpenGatesPerClient {
		return false
	}
	if p.held == nil {
		p.held = map[string]int{}
	}
	p.held[clientID]++
	return true
}

func (p *pollSlots) release(clientID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held[clientID]--; p.held[clientID] <= 0 {
		delete(p.held, clientID)
	}
}

// OpenGate handles POST /agent-sessions/gates for an authenticated principal.
func OpenGate(deps IngestDeps) func(http.ResponseWriter, *http.Request, *agentclient.Principal) {
	now := clock(deps.Now)
	return func(w http.ResponseWriter, r *http.Request, principal *agentclient.Principal) {
		raw, at, ok := admit(w, r, principal, deps.Limiter, now, hookwire.MaxGateBodyBytes)
		if !ok {
			return
		}
		request, err := hookwire.ParseGateRequest(raw)
		if err != nil {
			httpkit.WriteUnversioned(w, httpkit.Error(http.StatusBadRequest, "agent_gate_invalid_request", err.Error(), nil))
			return
		}
		reply, err := agentsession.OpenGate(r.Context(), deps.Pool, principal, request, at, deps.NewID)
		writeGate(w, deps, reply, err)
	}
}

// PollGate handles GET /agent-sessions/gates/{gateId}/decision: it answers as soon as
// the gate is decided, or after `wait` seconds (at most 25) with "pending".
// It holds nothing beyond the request itself.
func PollGate(deps IngestDeps) func(http.ResponseWriter, *http.Request, *agentclient.Principal) {
	now := clock(deps.Now)
	slots := &pollSlots{}
	return func(w http.ResponseWriter, r *http.Request, principal *agentclient.Principal) {
		if _, _, ok := admit(w, r, principal, deps.Limiter, now, 0); !ok {
			return
		}
		wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
		wait = min(max(wait, 0), hookwire.MaxGateWaitSeconds)
		// Past the cap the poll answers at once instead of waiting.
		if wait > 0 && slots.take(principal.ClientID) {
			defer slots.release(principal.ClientID)
		} else {
			wait = 0
		}
		deadline := time.Now().Add(time.Duration(wait) * time.Second)
		for {
			reply, err := agentsession.ReadGate(r.Context(), deps.Pool, principal, r.PathValue("gateId"), now())
			if err != nil || reply.Decision != hookwire.DecisionPending || !time.Now().Before(deadline) {
				writeGate(w, deps, reply, err)
				return
			}
			select {
			case <-r.Context().Done():
				return
			case <-time.After(gatePollInterval):
			}
		}
	}
}

func clock(now func() time.Time) func() time.Time {
	if now == nil {
		return time.Now
	}
	return now
}

func writeGate(w http.ResponseWriter, deps IngestDeps, reply hookwire.GateReply, err error) {
	switch {
	case errors.Is(err, agentsession.ErrNotGated):
		httpkit.WriteUnversioned(w, httpkit.Error(http.StatusConflict, "agent_gate_not_gated", err.Error(), nil))
	case errors.Is(err, agentsession.ErrGateContent):
		httpkit.WriteUnversioned(w, httpkit.Error(http.StatusBadRequest, "agent_gate_content_refused", err.Error(), nil))
	case errors.Is(err, agentsession.ErrGateSession), errors.Is(err, agentsession.ErrGateNotFound):
		httpkit.WriteUnversioned(w, httpkit.Error(http.StatusNotFound, "agent_gate_not_found", "gate or session not found", nil))
	case err != nil:
		if deps.Logger != nil {
			deps.Logger.Error("agent gate failed", "error", err)
		}
		httpkit.WriteUnversioned(w, httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil))
	default:
		httpkit.WriteUnversioned(w, httpkit.OK(reply))
	}
}

type decideBody struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

// decide is a person's answer to a held tool call. Agent and service tokens
// never decide; the client's creator may, unless the organization requires a
// second person.
func (s *service) decide(r *http.Request, rc httpkit.Request) httpkit.Result {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		return httpkit.Error(http.StatusForbidden, "person_required", "only a signed-in person decides a gate", nil)
	}
	var body decideBody
	if err := httpkit.DecodeBodyBounded(r, &body, 4<<10); err != nil {
		return httpkit.Error(http.StatusBadRequest, "invalid_body", "request body is not a valid gate decision", nil)
	}
	status := map[string]string{"approve": "approved", "deny": "denied"}[body.Decision]
	reason := strings.TrimSpace(body.Reason)
	if status == "" || len(reason) > 500 {
		return httpkit.Error(http.StatusBadRequest, "invalid_decision", "decision must be approve or deny, with a reason of at most 500 characters", nil)
	}
	id := r.PathValue("gateId")
	if uuid.Validate(id) != nil {
		return gateNotFound()
	}
	q := store.New(s.pool)
	gate, err := q.GetAgentGate(r.Context(), store.GetAgentGateParams{OrgID: rc.OrgID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return gateNotFound()
	}
	if err != nil {
		return internalError()
	}
	if gate.ClientCreatedBy == rc.UserID && s.secondPerson(r, rc) {
		return httpkit.Error(http.StatusForbidden, "agent_gate_self_decision",
			"this organization requires someone other than the agent client's creator to decide", nil)
	}
	now := s.now().UTC()
	decided, err := q.DecideAgentGate(r.Context(), store.DecideAgentGateParams{
		OrgID: rc.OrgID, ID: id, Status: status, DecidedBy: pgtype.Text{String: rc.UserID, Valid: true},
		DecidedAt: &now, Reason: pgtype.Text{String: reason, Valid: reason != ""},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpkit.Error(http.StatusConflict, "agent_gate_settled", "this gate was already decided or has expired", nil)
	}
	if err != nil {
		return internalError()
	}
	s.audit.Write(r.Context(), s.pool, rc.Auth, gateDecidedAction, audit.Options{
		TargetType: "agent_gate", TargetID: decided.ID,
		Metadata: map[string]any{
			"decision": decided.Status, "tool": decided.Tool, "sessionId": decided.SessionID,
			"agentClientId": decided.AgentClientID, "contentCaptured": len(gate.Content) > 0,
		},
	})
	return httpkit.OK(map[string]any{"gate": map[string]any{"id": decided.ID, "status": decided.Status}})
}

func gateNotFound() httpkit.Result {
	return httpkit.Error(http.StatusNotFound, "agent_gate_not_found", "gate not found", nil)
}

func (s *service) secondPerson(r *http.Request, rc httpkit.Request) bool {
	raw, err := store.New(s.pool).GetOrgConfigValue(r.Context(), store.GetOrgConfigValueParams{OrgID: rc.OrgID, Key: SecondPersonKey})
	if err != nil {
		// Unreadable policy is the strict one.
		return !errors.Is(err, pgx.ErrNoRows)
	}
	var required bool
	return json.Unmarshal(raw, &required) != nil || required
}

// pendingGates lists the session's open gates; canDecide says whether this
// viewer's decision would be accepted.
func (s *service) pendingGates(r *http.Request, rc httpkit.Request, sessionID, clientCreatedBy string) ([]map[string]any, error) {
	rows, err := store.New(s.pool).ListPendingAgentGatesForSession(r.Context(), store.ListPendingAgentGatesForSessionParams{
		OrgID: rc.OrgID, SessionID: sessionID, Now: s.now().UTC(),
	})
	if err != nil {
		return nil, err
	}
	// Captured input is for people of the deciding role only; a reader sees
	// that it exists, not what it holds.
	decider := len(rows) > 0 && rc.Auth != nil && auth.IsPersonMode(rc.Auth.Mode) &&
		holds(r, s.pool, rc, "agents.write", auth.RoleEditor)
	canDecide := decider && (clientCreatedBy != rc.UserID || !s.secondPerson(r, rc))
	gates := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		var input any
		if decider && len(row.Content) > 0 {
			var content struct {
				Input any `json:"input"`
			}
			_ = json.Unmarshal(row.Content, &content)
			input = content.Input
		}
		gates = append(gates, map[string]any{
			"id": row.ID, "tool": row.Tool, "mcpServer": optionalText(row.McpServer), "agentId": optionalText(row.AgentID),
			"contentCaptured": len(row.Content) > 0, "input": input,
			"expiresAt": row.ExpiresAt.UTC().Format(time.RFC3339Nano), "needsYou": canDecide,
		})
	}
	return gates, nil
}
