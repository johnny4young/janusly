//go:build integration

package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/johnny4young/janusly/internal/migrate"
	"github.com/johnny4young/janusly/internal/store"
)

func experienceTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/postgres"
	admin, err := pgxpool.New(t.Context(), u.String())
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("janusly_experience_%d", time.Now().UnixNano())
	if _, err := admin.Exec(t.Context(), `CREATE DATABASE "`+name+`" TEMPLATE template0`); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		defer admin.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Error(err)
		}
	})
	u.Path = "/" + name
	if err := migrate.Up(t.Context(), u.String()); err != nil {
		t.Fatal(err)
	}
	if err := migrate.Up(t.Context(), u.String()); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(u.String())
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedExperienceSource(t *testing.T, pool *pgxpool.Pool, org, workflow, version string, number int) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `INSERT INTO workflows(id,org_id,name) VALUES ($1,$2,'Local report') ON CONFLICT DO NOTHING`, workflow, org); err != nil {
		t.Fatal(err)
	}
	dag := map[string]any{"dslVersion": "1.0", "id": workflow, "name": "Local report", "nodes": []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}
	raw, _ := json.Marshal(dag)
	if _, err := pool.Exec(t.Context(), `INSERT INTO workflow_versions(id,org_id,workflow_id,version,dag_json) VALUES ($1,$2,$3,$4,$5)`, version, org, workflow, number, raw); err != nil {
		t.Fatal(err)
	}
}

func grantExperienceConsent(t *testing.T, pool *pgxpool.Pool, org string) {
	t.Helper()
	for key, value := range map[string]string{"memory.enabled": "true", "ai.authoringExperienceEnabled": "true", "memory.allowedKinds": `"workflow_vector"`} {
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs(id,org_id,key,value_json,updated_by,category,description,value_type) VALUES ($1||':'||$2,$1,$2,$3::jsonb,'operator',split_part($2,'.',1),'Experience consent fixture',CASE WHEN $2='memory.allowedKinds' THEN 'string' ELSE 'boolean' END) ON CONFLICT(org_id,key) DO UPDATE SET value_json=excluded.value_json`, org, key, value); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExperienceRegistryImmutableScopedConsentAndRevocation(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a1", 1)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a2", 2)
	seedExperienceSource(t, pool, "org-b", "wf-b", "ver-b1", 1)
	grantExperienceConsent(t, pool, "org-a")
	grantExperienceConsent(t, pool, "org-b")
	now := time.Now().UTC().Truncate(time.Microsecond).Add(time.Minute)
	registry := ExperienceRegistry{Pool: pool, Enabled: true, Now: func() time.Time { return now }}
	input := ExperienceRegistration{ID: "exp-a", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a1", Brief: registryBrief(), Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
	entry, err := registry.Register(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if entry.VersionID != "ver-a1" || entry.Version != 1 || entry.OutcomeEvidence != "unknown" || !entry.RetainUntil.Equal(now.AddDate(0, 0, 180)) {
		t.Fatalf("exact source/policy lost: %+v", entry)
	}
	now = now.Add(time.Hour)
	input.ID = "duplicate"
	duplicate, err := registry.Register(t.Context(), input)
	if err != nil || duplicate.ID != entry.ID || !duplicate.RetainUntil.Equal(entry.RetainUntil) {
		t.Fatalf("idempotence renewed or changed source: %+v %v", duplicate, err)
	}
	for _, c := range []struct{ org, workflow, version string }{{"org-a", "wf-a", "ver-b1"}, {"org-b", "wf-a", "ver-a1"}, {"org-a", "wf-a", "unknown"}} {
		input.OrganizationID = c.org
		input.WorkflowID = c.workflow
		input.VersionID = c.version
		if _, err := registry.Register(t.Context(), input); !errors.Is(err, ErrExperienceSourceUnavailable) {
			t.Fatalf("source scope bypass: %v", err)
		}
	}
	input.OrganizationID = "org-a"
	input.WorkflowID = "wf-a"
	input.VersionID = "ver-a1"
	list, err := registry.List(t.Context(), "org-a", "wf-a")
	if err != nil || len(list.Entries) != 1 || list.Truncated {
		t.Fatalf("list: %+v %v", list, err)
	}
	raw, _ := json.Marshal(list)
	for _, word := range []string{"brief", "nodes", "Prepare local text", "briefKey", "createdBy"} {
		if strings.Contains(string(raw), word) {
			t.Fatalf("list leaks %s: %s", word, raw)
		}
	}
	other, err := registry.List(t.Context(), "org-b", "wf-a")
	if err != nil || len(other.Entries) != 0 {
		t.Fatalf("list tenant leak: %+v %v", other, err)
	}
	if revoked, changed, err := registry.Revoke(t.Context(), "org-b", entry.ID); err != nil || revoked || changed {
		t.Fatalf("cross tenant revoke: %v %v %v", revoked, changed, err)
	}
	// Every writer observes atomic consent revocation, including a rollback.
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE org_configs SET value_json='false' WHERE org_id='org-a' AND key='memory.enabled'`); err != nil {
		_ = tx.Rollback(t.Context())
		t.Fatal(err)
	}
	var revoked bool
	if err := tx.QueryRow(t.Context(), `SELECT revoked_at IS NOT NULL FROM authoring_experiences WHERE id='exp-a'`).Scan(&revoked); err != nil || !revoked {
		_ = tx.Rollback(t.Context())
		t.Fatalf("not atomically revoked: %v %v", revoked, err)
	}
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT revoked_at IS NOT NULL FROM authoring_experiences WHERE id='exp-a'`).Scan(&revoked); err != nil || revoked {
		t.Fatalf("revocation escaped rollback: %v %v", revoked, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE org_configs SET value_json='false' WHERE org_id='org-a' AND key='memory.enabled'`); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.List(t.Context(), "org-a", "wf-a"); !errors.Is(err, ErrExperienceDisabled) {
		t.Fatalf("revoked consent admitted: %v", err)
	}
	if _, err := registry.Register(t.Context(), input); !errors.Is(err, ErrExperienceDisabled) {
		t.Fatalf("registration after disable: %v", err)
	}
	grantExperienceConsent(t, pool, "org-a")
	list, err = registry.List(t.Context(), "org-a", "wf-a")
	if err != nil || len(list.Entries) != 0 {
		t.Fatalf("regrant revived old registration: %+v %v", list, err)
	}
	input.ID = "exp-new"
	entry, err = registry.Register(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	registry.Enabled = false
	if revoked, changed, err := registry.Revoke(t.Context(), "org-a", entry.ID); err != nil || !revoked || !changed {
		t.Fatalf("disable prevented privacy withdrawal: %v %v %v", revoked, changed, err)
	}
	if revoked, changed, err := registry.Revoke(t.Context(), "org-a", entry.ID); err != nil || !revoked || changed {
		t.Fatalf("revoke not idempotent: %v %v %v", revoked, changed, err)
	}
	registry.Enabled = true
	if _, err := pool.Exec(t.Context(), `UPDATE workflows SET deleted_at=now() WHERE org_id='org-a' AND id='wf-a'`); err != nil {
		t.Fatal(err)
	}
	input.ID = "exp-deleted"
	if _, err := registry.Register(t.Context(), input); !errors.Is(err, ErrExperienceSourceUnavailable) {
		t.Fatalf("deleted parent admitted: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := registry.Register(ctx, input); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled registry admitted: %v", err)
	}
}

func TestExperienceRegistryListFiltersBeforeBoundedSentinelAndPurges(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	grantExperienceConsent(t, pool, "org-a")
	now := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	registry := ExperienceRegistry{Pool: pool, Enabled: true, Now: func() time.Time { return now }}
	for i := 0; i < 10; i++ {
		version := fmt.Sprintf("ver-%d", i)
		seedExperienceSource(t, pool, "org-a", "wf-a", version, i+1)
		input := ExperienceRegistration{ID: fmt.Sprintf("exp-%d", i), OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: version, Brief: registryBrief(), Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
		if _, err := registry.Register(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	// Later, ineligible rows must not consume the top-K.
	if _, err := pool.Exec(t.Context(), `UPDATE authoring_experiences SET registered_at=$1,retain_until=$2 WHERE id='exp-9'`, now.Add(time.Minute), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE authoring_experiences SET registered_at=$1,retain_until=$2 WHERE id='exp-8'`, now.Add(-48*time.Hour), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE authoring_experiences SET revoked_at=$1 WHERE id='exp-7'`, now.Add(-8*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions SET created_at=$1 WHERE id='ver-6'`, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	list, err := registry.List(t.Context(), "org-a", "wf-a")
	if err != nil || len(list.Entries) != 5 || !list.Truncated {
		t.Fatalf("top-K filtered after limit: %+v %v", list, err)
	}
	for i, entry := range list.Entries {
		if entry.ID != fmt.Sprintf("exp-%d", 5-i) {
			t.Fatalf("stable ordering: %+v", list)
		}
	}
	q := store.New(pool)
	count, err := q.PurgeAuthoringExperiencesBatch(t.Context(), store.PurgeAuthoringExperiencesBatchParams{AsOf: now, RevokedBefore: now.Add(-7 * 24 * time.Hour), BatchSize: 1})
	if err != nil || count != 1 {
		t.Fatalf("bounded batch: %d %v", count, err)
	}
	count, err = q.PurgeAuthoringExperiencesBatch(t.Context(), store.PurgeAuthoringExperiencesBatchParams{AsOf: now, RevokedBefore: now.Add(-7 * 24 * time.Hour), BatchSize: 1})
	if err != nil || count != 1 {
		t.Fatalf("second bounded batch: %d %v", count, err)
	}
	// The consent purge removes withdrawn rows only: an active registration
	// admitted after consent was re-granted must survive a racing sweep.
	var active int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences WHERE org_id='org-a' AND revoked_at IS NULL`).Scan(&active); err != nil || active == 0 {
		t.Fatalf("fixture needs active rows: %d %v", active, err)
	}
	if _, err := q.PurgeAuthoringExperiencesForOrg(t.Context(), "org-a"); err != nil {
		t.Fatal(err)
	}
	var survivors int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences WHERE org_id='org-a' AND revoked_at IS NULL`).Scan(&survivors); err != nil || survivors != active {
		t.Fatalf("consent purge deleted active registrations: %d of %d %v", survivors, active, err)
	}
	if _, err := pool.Exec(t.Context(), `DELETE FROM workflow_versions WHERE id='ver-5'`); err != nil {
		t.Fatal(err)
	}
	var orphan int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences WHERE workflow_version_id='ver-5'`).Scan(&orphan); err != nil || orphan != 0 {
		t.Fatalf("version deletion left reference: %d %v", orphan, err)
	}
}

func waitExperienceLock(t *testing.T, pool *pgxpool.Pool, fragment string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND strpos(query,$1)>0)`, fragment).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected live PostgreSQL lock wait for %s", fragment)
}

func TestExperienceRegistrationCannotOvertakeConcurrentRevocation(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a", 1)
	grantExperienceConsent(t, pool, "org-a")
	registry := ExperienceRegistry{Pool: pool, Enabled: true}
	input := ExperienceRegistration{ID: "exp-a", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a", Brief: registryBrief(), Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM workflow_versions WHERE id='ver-a' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	registered := make(chan error, 1)
	go func() { _, err := registry.Register(ctx, input); registered <- err }()
	waitExperienceLock(t, pool, "GetAuthoringExperienceVersion")
	revoked := make(chan error, 1)
	go func() {
		_, err := pool.Exec(ctx, `/* experience-revocation-race */ UPDATE org_configs SET value_json='false' WHERE org_id='org-a' AND key='memory.enabled'`)
		revoked <- err
	}()
	waitExperienceLock(t, pool, "experience-revocation-race")
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-registered; err != nil {
		t.Fatal(err)
	}
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	var isRevoked bool
	if err := pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM authoring_experiences WHERE id='exp-a'`).Scan(&isRevoked); err != nil || !isRevoked {
		t.Fatalf("concurrent registration escaped revocation: %v %v", isRevoked, err)
	}
	grantExperienceConsent(t, pool, "org-a")
	list, err := registry.List(ctx, "org-a", "wf-a")
	if err != nil || len(list.Entries) != 0 {
		t.Fatalf("regrant revived raced entry: %+v %v", list, err)
	}
}

func TestExperienceRegistrationRejectsReplacedOrIncompatibleSource(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a", 1)
	grantExperienceConsent(t, pool, "org-a")
	registry := ExperienceRegistry{Pool: pool, Enabled: true}
	input := ExperienceRegistration{ID: "exp-a", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a", Brief: registryBrief(), Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
	for _, dag := range []string{
		`{"id":"another-source","name":"Poisoned","nodes":[{"id":"done","type":"noop","config":{}}],"edges":[]}`,
		`{"id":"wf-a","name":"Poisoned","nodes":[{"id":"notify","type":"tool","config":{"tool":"invented.write","input":{}}}],"edges":[]}`,
		`{"id":"wf-a","name":"Poisoned","nodes":[{"id":"notify","type":"mcp_tool","config":{"connectionAlias":"foreign","toolName":"delete"}}],"edges":[]}`,
		`{"id":"wf-a","name":"Poisoned","nodes":[],"edges":[]}`,
	} {
		if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions SET dag_json=$1::jsonb WHERE id='ver-a'`, dag); err != nil {
			t.Fatal(err)
		}
		if _, err := registry.Register(t.Context(), input); !errors.Is(err, ErrExperienceSourceIncompatible) {
			t.Fatalf("incompatible exact source accepted: %v", err)
		}
	}
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failure partially registered: %d %v", count, err)
	}
}

func TestExperienceConsentDeletionAndKindRemovalRevokeImmediately(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a", 1)
	registry := ExperienceRegistry{Pool: pool, Enabled: true}
	for i, stmt := range []string{
		`DELETE FROM org_configs WHERE org_id='org-a' AND key='memory.enabled'`,
		`UPDATE org_configs SET value_json='"run_summary"' WHERE org_id='org-a' AND key='memory.allowedKinds'`,
		`DELETE FROM org_configs WHERE org_id='org-a' AND key='ai.authoringExperienceEnabled'`,
	} {
		grantExperienceConsent(t, pool, "org-a")
		input := ExperienceRegistration{ID: fmt.Sprintf("exp-%d", i), OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a", Brief: registryBrief(), Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
		if _, err := registry.Register(t.Context(), input); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), stmt); err != nil {
			t.Fatal(err)
		}
		var revoked bool
		if err := pool.QueryRow(t.Context(), `SELECT revoked_at IS NOT NULL FROM authoring_experiences WHERE id=$1`, input.ID).Scan(&revoked); err != nil || !revoked {
			t.Fatalf("consent reduction failed: %s %v %v", stmt, revoked, err)
		}
		if _, err := registry.List(t.Context(), "org-a", "wf-a"); !errors.Is(err, ErrExperienceDisabled) {
			t.Fatalf("reduced kind consent admitted: %v", err)
		}
	}
}

func TestExperienceRegistryBoundedListQueryPlanAtScale(t *testing.T) {
	pool := experienceTestPool(t)
	ctx := t.Context()
	for _, stmt := range []string{
		`INSERT INTO workflows(id,org_id,name) SELECT 'wf-scale-'||i,'org-scale-'||i,'Local report' FROM generate_series(0,499) i`,
		`INSERT INTO workflow_versions(id,org_id,workflow_id,version,dag_json) SELECT 'ver-scale-'||i,'org-scale-'||i,'wf-scale-'||i,1,jsonb_build_object('id','wf-scale-'||i,'name','Local report','nodes',jsonb_build_array(jsonb_build_object('id','done','type','noop','config','{}'::jsonb)),'edges','[]'::jsonb) FROM generate_series(0,499) i`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(registryBrief())
	if _, err := pool.Exec(ctx, `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by)
 SELECT 'exp-scale-'||i||'-'||j,'org-scale-'||i,'wf-scale-'||i,'ver-scale-'||i,md5(j::text)||md5(j::text),$1::jsonb,'authoring-experience-v1',now()-j*interval '1 second',now()+interval '1 day','operator'
 FROM generate_series(0,499) i CROSS JOIN generate_series(0,39) j`, raw); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE authoring_experiences; ANALYZE workflows; ANALYZE workflow_versions`); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../store/queries/authoringexperiences.sql")
	if err != nil {
		t.Fatal(err)
	}
	_, query, ok := strings.Cut(string(source), "-- name: ListAuthoringExperiences :many")
	if !ok {
		t.Fatal("canonical list query missing")
	}
	query, _, _ = strings.Cut(query, "-- name:")
	query = strings.NewReplacer("sqlc.arg(as_of)", "$3", "sqlc.arg(row_limit)", "$4").Replace(query)
	var planRaw []byte
	if err := pool.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query, "org-scale-0", "wf-scale-0", time.Now().UTC(), 6).Scan(&planRaw); err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		Plan struct {
			NodeType string  `json:"Node Type"`
			Rows     float64 `json:"Actual Rows"`
		} `json:"Plan"`
	}
	if json.Unmarshal(planRaw, &plans) != nil || len(plans) != 1 || plans[0].Plan.NodeType != "Limit" || plans[0].Plan.Rows != 6 {
		t.Fatalf("unbounded list plan: %s", planRaw)
	}
	if !strings.Contains(string(planRaw), "authoring_experiences_list_idx") {
		t.Fatalf("scoped ordered index not used: %s", planRaw)
	}
	t.Logf("canonical list query on 20,000 registrations across 500 organizations: %s", planRaw)
}

func TestExperienceRegistryRetentionOverrideAndExplicitReregistration(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a", 1)
	grantExperienceConsent(t, pool, "org-a")
	retention, _ := json.Marshal(`{"workflow_vector":7}`)
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs(id,org_id,key,value_json,updated_by,category,description,value_type) VALUES('retention','org-a','memory.retentionDaysByKind',$1::jsonb,'operator','memory','Retention fixture','string')`, retention); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	registry := ExperienceRegistry{Pool: pool, Enabled: true, Now: func() time.Time { return now }}
	input := ExperienceRegistration{ID: "exp-original", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a", Brief: registryBrief(), Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
	before, err := registry.Register(t.Context(), input)
	if err != nil || !before.RetainUntil.Equal(now.AddDate(0, 0, 7)) {
		t.Fatalf("selected kind retention exceeded: %+v %v", before, err)
	}
	now = before.RetainUntil
	if list, err := registry.List(t.Context(), "org-a", "wf-a"); err != nil || len(list.Entries) != 0 {
		t.Fatalf("exact expiry admitted: %+v %v", list, err)
	}
	input.ID = "exp-new"
	after, err := registry.Register(t.Context(), input)
	if err != nil || after.ID != input.ID || !after.RegisteredAt.Equal(now) {
		t.Fatalf("explicit registration after expiry: %+v %v", after, err)
	}
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences WHERE id='exp-original'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired source not removed: %d %v", count, err)
	}
}

func TestExperienceRegistrationChecksStoredJSONByteBoundary(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a", 1)
	grantExperienceConsent(t, pool, "org-a")
	brief := registryBrief()
	for i := 0; i < 6; i++ {
		brief.Examples = append(brief.Examples, fmt.Sprintf("%d:", i)+strings.Repeat("x", 1198))
	}
	brief.Examples = append(brief.Examples, "")
	raw, _ := json.Marshal(brief)
	brief.Examples[6] = strings.Repeat("y", MaxDecisionRequestBytes-len(raw))
	raw, _ = json.Marshal(brief)
	if len(raw) != MaxDecisionRequestBytes {
		t.Fatalf("fixture does not hit raw byte boundary: %d", len(raw))
	}
	input := ExperienceRegistration{ID: "exp-boundary", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a", Brief: brief, Catalog: NewBuilder(nil, nil).Build(t.Context(), "org-a")}
	if _, _, err := validateExperienceRegistration(input); err != nil {
		t.Fatalf("canonical raw boundary rejected unexpectedly: %v", err)
	}
	var storageBytes int
	if err := pool.QueryRow(t.Context(), `SELECT octet_length($1::jsonb::text)`, raw).Scan(&storageBytes); err != nil || storageBytes <= MaxDecisionRequestBytes {
		t.Fatalf("fixture does not exceed stored byte boundary: %d %v", storageBytes, err)
	}
	registry := ExperienceRegistry{Pool: pool, Enabled: true}
	if _, err := registry.Register(t.Context(), input); !errors.Is(err, ErrExperienceBriefInvalid) {
		t.Fatalf("stored overflow must be a closed invalid request, not raw DB error: %v", err)
	}
}
