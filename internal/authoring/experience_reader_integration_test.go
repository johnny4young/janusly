//go:build integration

package authoring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func registeredDecisionFixture(t *testing.T) (*ExperienceRegistry, DecisionRequest, Catalog, *pgxpool.Pool) {
	t.Helper()
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	pool := experienceTestPool(t)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a1", 1)
	seedExperienceSource(t, pool, "org-a", "wf-a", "ver-a2", 2)
	grantExperienceConsent(t, pool, "org-a")
	now := time.Now().UTC().Truncate(time.Microsecond).Add(time.Minute)
	registry := &ExperienceRegistry{Pool: pool, Enabled: true, Now: func() time.Time { return now }}
	catalog := NewBuilder(nil, nil).Build(t.Context(), "org-a")
	brief := registryBrief()
	if _, err := registry.Register(t.Context(), ExperienceRegistration{ID: "exp-a", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a1", Brief: brief, Catalog: catalog}); err != nil {
		t.Fatal(err)
	}
	request := DecisionRequest{OrganizationID: "org-a", ContextRevision: "revision-a", CatalogVersion: catalog.Version, Brief: brief, Complete: true}
	return registry, request, catalog, pool
}

func TestExperienceReaderExactVersionAndCurrentConsentFences(t *testing.T) {
	registry, request, catalog, pool := registeredDecisionFixture(t)
	selected, err := registry.Decide(t.Context(), request, catalog)
	if err != nil || selected.Receipt.Mode != DecisionReuse || selected.Receipt.Source == nil || selected.Receipt.Source.VersionID != "ver-a1" || selected.Receipt.Source.Version != 1 {
		t.Fatalf("exact selection: %+v %v", selected.Receipt, err)
	}
	if !selected.Request.Consent || !selected.Request.AsOf.Equal(registry.now()) {
		t.Fatal("caller supplied eligibility time/consent instead of live facts")
	}
	draft, err := registry.Resolve(t.Context(), request, selected.Receipt, catalog, "new-draft")
	if err != nil {
		t.Fatal(err)
	}
	workflow, issues := domain.Parse(draft)
	if len(issues) > 0 || workflow.ID != "new-draft" {
		t.Fatalf("copy: %v %s", issues, draft)
	}
	var id string
	if err := pool.QueryRow(t.Context(), `SELECT dag_json->>'id' FROM workflow_versions WHERE id='ver-a1'`).Scan(&id); err != nil || id != "wf-a" {
		t.Fatalf("source mutated: %s %v", id, err)
	}
	if _, _, err := registry.Revoke(t.Context(), "org-a", "exp-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Resolve(t.Context(), request, selected.Receipt, catalog, "another-draft"); !errors.Is(err, ErrExperienceSourceUnavailable) {
		t.Fatalf("revoked receipt admitted: %v", err)
	}
	if _, err := registry.Register(t.Context(), ExperienceRegistration{ID: "fresh-exp", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a1", Brief: request.Brief, Catalog: catalog}); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Resolve(t.Context(), request, selected.Receipt, catalog, "another-draft"); !errors.Is(err, ErrExperienceSourceUnavailable) {
		t.Fatalf("old receipt silently substituted fresh registration: %v", err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE org_configs SET value_json='false' WHERE org_id='org-a' AND key='memory.enabled'`); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Decide(t.Context(), request, catalog); !errors.Is(err, ErrExperienceDisabled) {
		t.Fatalf("withdrawn tenant consent admitted: %v", err)
	}
}

func TestExperienceReaderScopesSourcesAndDiscardsIncompatibleBeforeTopK(t *testing.T) {
	registry, request, catalog, pool := registeredDecisionFixture(t)
	key, err := CanonicalExperienceKey(request.Brief)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(request.Brief)
	now := registry.now()
	for i := range 20 {
		version := fmt.Sprintf("future-%d", i)
		seedExperienceSource(t, pool, "org-a", "wf-a", version, 100+i)
		if _, err := pool.Exec(t.Context(), `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by) VALUES ($1,'org-a','wf-a',$2,$3,$4,'authoring-experience-v1',$5,$6,'operator')`, "exp-"+version, version, key, raw, now.Add(time.Hour), now.AddDate(0, 0, 20)); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 5 {
		version := fmt.Sprintf("bad-%d", i)
		seedExperienceSource(t, pool, "org-a", "wf-a", version, 200+i)
		if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions SET dag_json=jsonb_set(dag_json,'{nodes,0,type}','"unsupported"') WHERE id=$1`, version); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by) VALUES ($1,'org-a','wf-a',$2,$3,$4,'authoring-experience-v1',$5,$6,'operator')`, "exp-"+version, version, key, raw, now, now.AddDate(0, 0, 20)); err != nil {
			t.Fatal(err)
		}
	}
	selected, err := registry.Decide(t.Context(), request, catalog)
	if err != nil || selected.Receipt.Mode != DecisionReuse || len(selected.Request.Candidates) != 1 || selected.Request.Truncated {
		t.Fatalf("future/incompatible rows consumed final top-K: %+v %v", selected.Receipt, err)
	}
	seedExperienceSource(t, pool, "org-b", "wf-b", "ver-b1", 1)
	grantExperienceConsent(t, pool, "org-b")
	if _, err := registry.Register(t.Context(), ExperienceRegistration{ID: "exp-b", OrganizationID: "org-b", ActorID: "operator", WorkflowID: "wf-b", VersionID: "ver-b1", Brief: request.Brief, Catalog: catalog}); err != nil {
		t.Fatal(err)
	}
	foreign := request
	foreign.OrganizationID = "org-b"
	other, err := registry.Decide(t.Context(), foreign, catalog)
	if err != nil || other.Receipt.Source == nil || other.Receipt.Source.CandidateID != "exp-b" {
		t.Fatalf("foreign source admitted: %+v %v", other.Receipt, err)
	}
	// The bounded raw scan is a work horizon, not the eligible top-K. If it
	// cannot establish completeness, disclose truncation instead of guessing.
	seedExperienceSource(t, pool, "org-a", "wf-a", "bad-5", 205)
	if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions SET dag_json=jsonb_set(dag_json,'{nodes,0,type}','"unsupported"') WHERE id='bad-5'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by) VALUES ('exp-bad-5','org-a','wf-a','bad-5',$1,$2,'authoring-experience-v1',$3,$4,'operator')`, key, raw, now, now.AddDate(0, 0, 20)); err != nil {
		t.Fatal(err)
	}
	selected, err = registry.Decide(t.Context(), request, catalog)
	if err != nil || selected.Receipt.Reason != DecisionCandidatesTruncated || selected.Receipt.Source != nil {
		t.Fatalf("incomplete source horizon guessed admission: %+v %v", selected.Receipt, err)
	}
}

func TestExperienceReaderRechecksNewAmbiguityDeletionAndCancellation(t *testing.T) {
	registry, request, catalog, pool := registeredDecisionFixture(t)
	selected, err := registry.Decide(t.Context(), request, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Register(t.Context(), ExperienceRegistration{ID: "second", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a2", Brief: request.Brief, Catalog: catalog}); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Resolve(t.Context(), request, selected.Receipt, catalog, "draft"); !errors.Is(err, ErrExperienceSourceUnavailable) {
		t.Fatalf("new ambiguity missed by resolve: %v", err)
	}
	if _, _, err := registry.Revoke(t.Context(), "org-a", "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflows SET deleted_at=now() WHERE id='wf-a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Resolve(t.Context(), request, selected.Receipt, catalog, "draft"); !errors.Is(err, ErrExperienceSourceUnavailable) {
		t.Fatalf("deleted parent admitted: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := registry.Decide(ctx, request, catalog); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := registry.Resolve(ctx, request, selected.Receipt, catalog, "draft"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled resolve: %v", err)
	}
}

func TestExperienceHistoricalReaderFiltersBeforeLimitWithoutCurrentConsentInference(t *testing.T) {
	registry, request, _, pool := registeredDecisionFixture(t)
	key, _ := CanonicalExperienceKey(request.Brief)
	stamp := registry.now()
	if _, err := pool.Exec(t.Context(), `UPDATE authoring_experiences SET revoked_at=$1 WHERE id='exp-a'`, stamp.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflows SET deleted_at=$1 WHERE id='wf-a'`, stamp.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	q := store.New(pool)
	params := store.FindAuthoringExperienceCandidatesParams{OrgID: request.OrganizationID, BriefKey: key, AsOf: stamp, Historical: true}
	rows, err := q.FindAuthoringExperienceCandidates(t.Context(), params)
	if err != nil || len(rows) != 1 {
		t.Fatalf("future tombstone erased past: rows=%d err=%v", len(rows), err)
	}
	params.Historical = false
	rows, err = q.FindAuthoringExperienceCandidates(t.Context(), params)
	if err != nil || len(rows) != 0 {
		t.Fatalf("live reader ignored tombstone: rows=%d err=%v", len(rows), err)
	}
	params.Historical = true
	params.AsOf = stamp.Add(time.Hour)
	rows, err = q.FindAuthoringExperienceCandidates(t.Context(), params)
	if err != nil || len(rows) != 0 {
		t.Fatalf("exact tombstone boundary: rows=%d err=%v", len(rows), err)
	}
}

func TestExperienceResolveConsentSerializesRegistrationWithoutLockUpgrade(t *testing.T) {
	registry, request, catalog, pool := registeredDecisionFixture(t)
	selected, err := registry.Decide(t.Context(), request, catalog)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	tx, _, _, err := registry.consentTx(ctx, request.OrganizationID, true)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackExperienceTx(ctx, tx)
	result := make(chan error, 1)
	go func() {
		_, err := registry.Register(ctx, ExperienceRegistration{ID: "concurrent-registration", OrganizationID: "org-a", ActorID: "operator", WorkflowID: "wf-a", VersionID: "ver-a2", Brief: request.Brief, Catalog: catalog})
		result <- err
	}()
	waitExperienceLock(t, pool, "LockAuthoringExperienceConsent")
	select {
	case err := <-result:
		t.Fatalf("registration overtook resolution fence: %v", err)
	default:
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := registry.Resolve(ctx, request, selected.Receipt, catalog, "stale-draft"); !errors.Is(err, ErrExperienceSourceUnavailable) {
		t.Fatalf("new registration not seen after serialized fence: %v", err)
	}
}

func TestExperienceReaderHistoricalVersionAndUnicodeOrderingBeforeHorizon(t *testing.T) {
	registry, request, _, pool := registeredDecisionFixture(t)
	key, _ := CanonicalExperienceKey(request.Brief)
	raw, _ := json.Marshal(request.Brief)
	now := registry.now()
	if _, err := pool.Exec(t.Context(), `UPDATE authoring_experiences SET revoked_at=$1 WHERE id='exp-a'`, now); err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"z", "é", "界"} {
		version := fmt.Sprintf("unicode-version-%d", i)
		seedExperienceSource(t, pool, "org-a", "wf-a", version, 10+i)
		if _, err := pool.Exec(t.Context(), `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by) VALUES($1,'org-a','wf-a',$2,$3,$4,'authoring-experience-v1',$5,$6,'operator')`, id, version, key, raw, now, now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 15 {
		version := fmt.Sprintf("future-created-%d", i)
		seedExperienceSource(t, pool, "org-a", "wf-a", version, 30+i)
		if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions SET created_at=$1 WHERE id=$2`, now.Add(time.Hour), version); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by) VALUES($1,'org-a','wf-a',$2,$3,$4,'authoring-experience-v1',$5,$6,'operator')`, "future-entry-"+version, version, key, raw, now, now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := store.New(pool).FindAuthoringExperienceCandidates(t.Context(), store.FindAuthoringExperienceCandidatesParams{OrgID: request.OrganizationID, BriefKey: key, AsOf: now, Historical: true})
	if err != nil || len(rows) != 3 || rows[0].ID != "界" || rows[1].ID != "é" || rows[2].ID != "z" {
		t.Fatalf("future version or locale-dependent order changed past horizon: rows=%+v err=%v", rows, err)
	}
}

func TestExperienceCandidateQueryUsesScopedHistoryIndexAtScale(t *testing.T) {
	pool := experienceTestPool(t)
	ctx := t.Context()
	for _, sql := range []string{
		`INSERT INTO workflows(id,org_id,name) SELECT 'wf-'||i,'org-'||i,'Fixture' FROM generate_series(0,499) i`,
		`INSERT INTO workflow_versions(id,org_id,workflow_id,version,dag_json) SELECT 'ver-'||i,'org-'||i,'wf-'||i,1,jsonb_build_object('dslVersion','1.0','id','wf-'||i,'nodes',jsonb_build_array(jsonb_build_object('id','done','type','noop','config','{}'::jsonb)),'edges','[]'::jsonb) FROM generate_series(0,499) i`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(registryBrief())
	if _, err := pool.Exec(ctx, `INSERT INTO authoring_experiences(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by)
 SELECT 'exp-'||i||'-'||j,'org-'||i,'wf-'||i,'ver-'||i,md5(j::text)||md5(j::text),$1::jsonb,'authoring-experience-v1',now()-j*interval '1 second',now()+interval '1 day','operator'
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
	_, query, ok := strings.Cut(string(source), "-- name: FindAuthoringExperienceCandidates :many")
	if !ok {
		t.Fatal("canonical candidate query missing")
	}
	query, _, _ = strings.Cut(query, "-- name:")
	query = strings.NewReplacer("sqlc.arg(as_of)", "$3", "sqlc.arg(historical)", "$4").Replace(query)
	var plan []byte
	if err := pool.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query, "org-0", "cfcd208495d565ef66e7dff9f98764dacfcd208495d565ef66e7dff9f98764da", time.Now().UTC(), true).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plan), "authoring_experiences_history_match_idx") {
		t.Fatalf("scoped deterministic history index not used: %s", plan)
	}
	t.Logf("canonical historical candidate query on 20,000 references across 500 organizations: %s", plan)
}

func TestExperienceReaderStageBudgetAndInFlightCancellation(t *testing.T) {
	registry, request, catalog, pool := registeredDecisionFixture(t)
	selected, err := registry.Decide(t.Context(), request, catalog)
	if err != nil {
		t.Fatal(err)
	}
	// A blocked SQL read must consume the same bounded stage as binding/copy;
	// database contention does not grant a longer decision timeout.
	blocker, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackExperienceTx(t.Context(), blocker)
	if _, err := blocker.Exec(t.Context(), `SELECT id FROM authoring_experiences WHERE id='exp-a' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if result, err := registry.Decide(t.Context(), request, catalog); !errors.Is(err, context.DeadlineExceeded) || result.Receipt.Source != nil {
		t.Fatalf("blocked decision escaped stage budget: %+v %v", result, err)
	}
	t.Logf("contention terminated at the unchanged %s stage deadline; observed wall time including rollback: %s", DecisionStageTimeout, time.Since(started))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	type resolution struct {
		draft []byte
		err   error
	}
	finished := make(chan resolution, 1)
	go func() {
		draft, err := registry.Resolve(ctx, request, selected.Receipt, catalog, "cancelled-draft")
		finished <- resolution{draft: draft, err: err}
	}()
	waitExperienceLock(t, pool, "FindAuthoringExperienceCandidates")
	cancel()
	result := <-finished
	if len(result.draft) != 0 || !errors.Is(result.err, context.Canceled) {
		t.Fatalf("in-flight cancellation admitted a draft or lost caller cancellation: %s %v", result.draft, result.err)
	}
	if err := blocker.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if current, err := registry.Decide(t.Context(), request, catalog); err != nil || current.Receipt.Mode != DecisionReuse {
		t.Fatalf("cancelled resolution retained consent/source locks: %+v %v", current, err)
	}
}
