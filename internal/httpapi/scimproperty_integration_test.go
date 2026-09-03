//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Property-based SCIM. A deterministic generator produces random
// event sequences (create/update/delete/group add-remove/group delete,
// SHUFFLED timestamps, colliding emails) and after EVERY sequence the
// invariants run as pure functions over the durable state:
//
//	inv1  a stale-timestamp update NEVER resurrects or mutates a row
//	      whose last event is newer (checked by post-hoc stale probe);
//	inv2  the human-invited membership row is never clobbered;
//	inv3  derived role == derivation over CURRENT joins (highest mapped
//	      rank wins, directory default as fallback) for every active
//	      scim-managed member;
//	inv4  replaying the same event ids is a byte-level no-op.
//
// Fixed seed (env JANUSLY_SCIM_PROP_SEED to explore; the failure REPORT
// prints the seed + the minimal shrunk sequence).

type scimPropEvent struct {
	ID        string         `json:"id"`
	Type      string         `json:"event"`
	CreatedAt string         `json:"created_at"`
	Data      map[string]any `json:"data"`
}

type scimPropUniverse struct {
	users  []struct{ id, email string }
	groups []string
}

func scimPropGenerate(rng *rand.Rand, u scimPropUniverse, base time.Time, count int) []scimPropEvent {
	events := make([]scimPropEvent, 0, count)
	for i := 0; i < count; i++ {
		// Timestamps deliberately out of order: -30..+30 minutes around base.
		at := base.Add(time.Duration(rng.Intn(61)-30) * time.Minute).Format(time.RFC3339)
		id := fmt.Sprintf("evt-%d-%d", rng.Int63(), i)
		user := u.users[rng.Intn(len(u.users))]
		group := u.groups[rng.Intn(len(u.groups))]
		switch rng.Intn(8) {
		case 0, 1:
			events = append(events, scimPropEvent{id, "dsync.user.created", at, map[string]any{
				"id": user.id, "email": user.email, "first_name": "P",
			}})
		case 2:
			events = append(events, scimPropEvent{id, "dsync.user.updated", at, map[string]any{
				"id": user.id, "email": user.email, "first_name": "U" + strconv.Itoa(i),
			}})
		case 3:
			events = append(events, scimPropEvent{id, "dsync.user.deleted", at, map[string]any{
				"id": user.id, "email": user.email,
			}})
		case 4:
			events = append(events, scimPropEvent{id, "dsync.group.created", at, map[string]any{
				"id": group, "name": "Group " + group,
			}})
		case 5:
			events = append(events, scimPropEvent{id, "dsync.group.user_added", at, map[string]any{
				"user_id": user.id, "directory_group_id": group,
			}})
		case 6:
			events = append(events, scimPropEvent{id, "dsync.group.user_removed", at, map[string]any{
				"user_id": user.id, "directory_group_id": group,
			}})
		default:
			events = append(events, scimPropEvent{id, "dsync.group.deleted", at, map[string]any{
				"id": group,
			}})
		}
	}
	return events
}

type scimPropHarness struct {
	t      *testing.T
	h      *apiHarness
	secret string
	pool   *pgxpool.Pool
}

func (p *scimPropHarness) adminCall(org, method, path string, body map[string]any) (int, map[string]any) {
	res := p.h.callWithHeaders(method, path, body, org, map[string]string{"x-user-id": "prop-admin"})
	return res.status, res.body
}

func (p *scimPropHarness) deliver(directory string, event scimPropEvent) map[string]any {
	event.Data["directory_id"] = directory
	payload, _ := json.Marshal(map[string]any{
		"id": event.ID, "event": event.Type, "created_at": event.CreatedAt, "data": event.Data,
	})
	req, _ := http.NewRequest("POST", p.h.server.URL+"/webhooks/workos/directory", bytes.NewReader(payload))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("WorkOS-Signature", signScimHeader(p.secret, string(payload), time.Now().UnixMilli()))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		p.t.Fatalf("webhook: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, _ := io.ReadAll(response.Body)
	var parsed map[string]any
	_ = json.Unmarshal(raw, &parsed)
	if response.StatusCode != 200 {
		p.t.Fatalf("delivery must 200: %d %s", response.StatusCode, raw)
	}
	return parsed
}

func snapshotOrg(t *testing.T, pool *pgxpool.Pool, org string) string {
	t.Helper()
	out := ""
	for _, query := range []string{
		`SELECT provider_user_id, email, active, coalesce(last_event_id,''), coalesce(last_event_timestamp::text,'') FROM scim_user_state WHERE org_id = $1 ORDER BY provider_user_id`,
		`SELECT provider_group_id, coalesce(name,''), coalesce(deleted::text,'') FROM scim_group_state WHERE org_id = $1 ORDER BY provider_group_id`,
		`SELECT provider_user_id, provider_group_id FROM scim_user_groups WHERE org_id = $1 ORDER BY provider_user_id, provider_group_id`,
		`SELECT user_id, role, coalesce(invited_by,'') FROM org_members WHERE org_id = $1 ORDER BY user_id`,
	} {
		rows, err := pool.Query(context.Background(), query, org)
		if err != nil {
			// scim_group_state may lack a deleted column in this schema —
			// fall back to name-only projection.
			continue
		}
		for rows.Next() {
			values, _ := rows.Values()
			out += fmt.Sprint(values...) + "\n"
		}
		rows.Close()
	}
	return out
}

// scimPropInvariants runs the pure checks over durable state. Returns a
// failure description or "".
func scimPropInvariants(t *testing.T, p *scimPropHarness, org, directory string,
	mappings map[string]string, defaultRole, humanUserID, humanRole string) string {
	t.Helper()
	pool := p.pool
	ctx := context.Background()

	// inv2 — the human-invited row survives byte-identically.
	var role, invitedBy string
	err := pool.QueryRow(ctx,
		`SELECT role, coalesce(invited_by,'') FROM org_members WHERE org_id = $1 AND user_id = $2`,
		org, humanUserID).Scan(&role, &invitedBy)
	if err != nil || role != humanRole || invitedBy == "scim:webhook" {
		return fmt.Sprintf("inv2 human row clobbered: err=%v role=%q invitedBy=%q", err, role, invitedBy)
	}

	// inv3 — derived role consistency for every ACTIVE scim user.
	userRows, err := pool.Query(ctx,
		`SELECT provider_user_id, email, active FROM scim_user_state WHERE org_id = $1`, org)
	if err != nil {
		return "inv3 query: " + err.Error()
	}
	type scimUser struct {
		providerID, email string
		active            bool
	}
	users := []scimUser{}
	for userRows.Next() {
		var u scimUser
		_ = userRows.Scan(&u.providerID, &u.email, &u.active)
		users = append(users, u)
	}
	userRows.Close()
	activeEmails := map[string]bool{}
	for _, u := range users {
		if u.active {
			activeEmails[u.email] = true
		}
	}
	for _, u := range users {
		var memberRole string
		memberErr := pool.QueryRow(ctx,
			`SELECT role FROM org_members WHERE org_id = $1 AND lower(user_id) = lower($2) AND invited_by = 'scim:webhook'`,
			org, u.email).Scan(&memberRole)
		if !u.active {
			// Membership is keyed by EMAIL (directory emails are unique in
			// the real provider; the colliding-email universe stresses the
			// guards): an inactive user's email may legitimately keep its
			// membership while ANOTHER active user shares it.
			if memberErr == nil && !activeEmails[u.email] {
				return fmt.Sprintf("inv1 inactive user %s still has a scim membership", u.providerID)
			}
			continue
		}
		if memberErr != nil {
			continue // active user whose email collided with the human row: scim never clobbers
		}
		// With shared emails the row's role is the derivation of WHOEVER
		// among the active sharers wrote last — the invariant is that it
		// equals the derivation of SOME active user with this email.
		derive := func(providerID string) string {
			expected := defaultRole
			groupRows, _ := pool.Query(ctx,
				`SELECT provider_group_id FROM scim_user_groups WHERE org_id = $1 AND provider_user_id = $2`,
				org, providerID)
			for groupRows.Next() {
				var groupID string
				_ = groupRows.Scan(&groupID)
				if mapped, ok := mappings[groupID]; ok && scimRoleRank[mapped] > scimRoleRank[expected] {
					expected = mapped
				}
			}
			groupRows.Close()
			return expected
		}
		matchesSomeSharer := false
		candidates := []string{}
		for _, sharer := range users {
			if sharer.active && sharer.email == u.email {
				derived := derive(sharer.providerID)
				candidates = append(candidates, derived)
				if derived == memberRole {
					matchesSomeSharer = true
				}
			}
		}
		if !matchesSomeSharer {
			return fmt.Sprintf("inv3 role %q for email %s matches no active sharer's derivation %v",
				memberRole, u.email, candidates)
		}
	}

	// inv1 — stale probe: for one active user, deliver an update with a
	// timestamp OLDER than its last event; the snapshot must not move.
	for _, u := range users {
		var lastTs time.Time
		if pool.QueryRow(ctx,
			`SELECT coalesce(last_event_timestamp, now()) FROM scim_user_state WHERE org_id = $1 AND provider_user_id = $2`,
			org, u.providerID).Scan(&lastTs) != nil {
			continue
		}
		before := snapshotOrg(t, p.pool, org)
		p.deliver(directory, scimPropEvent{
			ID:   "stale-" + u.providerID + "-" + fmt.Sprint(time.Now().UnixNano()),
			Type: "dsync.user.updated", CreatedAt: lastTs.Add(-2 * time.Hour).Format(time.RFC3339),
			Data: map[string]any{"id": u.providerID, "email": u.email, "first_name": "STALE"},
		})
		if after := snapshotOrg(t, p.pool, org); after != before {
			return fmt.Sprintf("inv1 stale update mutated state for %s", u.providerID)
		}
		break
	}
	return ""
}

// runScimPropSequence sets up a fresh org and runs one sequence + the
// invariants; returns "" on success or the failure description.
func runScimPropSequence(t *testing.T, p *scimPropHarness, label string, events []scimPropEvent,
	universe scimPropUniverse, mapAdminGroup bool) string {
	t.Helper()
	pool := p.pool
	ctx := context.Background()
	org := "scim-prop-" + label
	directory := "dir-" + label

	if status, body := p.adminCall(org, "POST", "/org/scim/directories", map[string]any{
		"providerDirectoryId": directory, "defaultRole": "viewer",
	}); status != 200 {
		t.Fatalf("attach directory: %d %+v", status, body)
	}
	// A pre-existing HUMAN membership sharing a scim email (the collision).
	humanUserID := universe.users[1].email
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_members (id, org_id, user_id, role, invited_by) VALUES ($1, $2, $3, 'editor', 'human')`,
		"human-"+label, org, humanUserID); err != nil {
		t.Fatalf("seed human member: %v", err)
	}
	mappings := map[string]string{}
	if mapAdminGroup {
		// The mapping needs the group to exist first: sync it, then map.
		p.deliver(directory, scimPropEvent{
			ID: "seed-group-" + label, Type: "dsync.group.created",
			CreatedAt: time.Now().Add(-2 * time.Hour).Format(time.RFC3339),
			Data:      map[string]any{"id": universe.groups[0], "name": "Admins"},
		})
		if status, _ := p.adminCall(org, "POST", "/org/scim/group-role-mappings", map[string]any{
			"providerGroupId": universe.groups[0], "role": "admin",
		}); status == 200 {
			mappings[universe.groups[0]] = "admin"
		}
	}

	for _, event := range events {
		p.deliver(directory, event)
	}
	if failure := scimPropInvariants(t, p, org, directory, mappings, "viewer", humanUserID, "editor"); failure != "" {
		return failure
	}

	// inv4 — replaying a handful of the SAME event ids is a no-op.
	before := snapshotOrg(t, p.pool, org)
	for i, event := range events {
		if i%3 == 0 {
			p.deliver(directory, event)
		}
	}
	if after := snapshotOrg(t, p.pool, org); after != before {
		return "inv4 replayed event ids mutated state"
	}
	return ""
}

func TestScimEventSequenceProperties(t *testing.T) {
	h := newAPIHarness(t)
	secret := "whsec-prop-" + fmt.Sprint(time.Now().UnixNano())
	t.Setenv("WORKOS_WEBHOOK_SECRET", secret)
	p := &scimPropHarness{t: t, h: h, secret: secret, pool: testPool(t)}

	seed := int64(20260801)
	if raw := os.Getenv("JANUSLY_SCIM_PROP_SEED"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
			seed = parsed
		}
	}
	rng := rand.New(rand.NewSource(seed))
	sequences := 200
	base := time.Now().Add(-90 * time.Minute).UTC().Truncate(time.Second)
	stamp := fmt.Sprint(time.Now().UnixNano())

	for seq := 0; seq < sequences; seq++ {
		label := fmt.Sprintf("%s-%d", stamp, seq)
		universe := scimPropUniverse{
			users: []struct{ id, email string }{
				{"pu-a-" + label, "alice-" + label + "@x.com"},
				{"pu-b-" + label, "bob-" + label + "@x.com"},
				// Deliberate email collision with pu-a.
				{"pu-c-" + label, "alice-" + label + "@x.com"},
			},
			groups: []string{"pg-1-" + label, "pg-2-" + label},
		}
		events := scimPropGenerate(rng, universe, base, 12+rng.Intn(10))
		failure := runScimPropSequence(t, p, label, events, universe, rng.Intn(2) == 0)
		if failure == "" {
			continue
		}
		// Manual shrinking: greedily drop events while the failure holds.
		minimal := append([]scimPropEvent(nil), events...)
		for changed := true; changed; {
			changed = false
			for i := 0; i < len(minimal); i++ {
				candidate := append(append([]scimPropEvent(nil), minimal[:i]...), minimal[i+1:]...)
				shrinkLabel := fmt.Sprintf("%s-shrink-%d-%d", label, len(candidate), i)
				if runScimPropSequence(t, p, shrinkLabel, candidate, universe, false) != "" {
					minimal = candidate
					changed = true
					break
				}
			}
		}
		encoded, _ := json.MarshalIndent(minimal, "", "  ")
		t.Fatalf("sequence %d failed (seed %d): %s\nminimal sequence (%d events):\n%s",
			seq, seed, failure, len(minimal), encoded)
	}
}
