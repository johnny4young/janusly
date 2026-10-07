package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/migrate"
)

type registryFixtureReport struct {
	Evidence             string   `json:"evidence"`
	Checks               []string `json:"checks"`
	ActualLogicalCalls   int      `json:"actualLogicalCalls"`
	SDKTransportRequests int      `json:"sdkTransportRequests"`
}

// The opt-in fixture lane creates and removes its own fresh database. It never
// registers, reads or mutates a real tenant's workflow, and has no model client.
func runRegistryFixture(ctx context.Context, dsn string, out io.Writer) error {
	report, err := checkRegistryFixture(ctx, dsn)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(report)
}

func fixtureAdminConfig(dsn string) (*pgxpool.Config, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
		return nil, errors.New("registry fixture requires a loopback PostgreSQL 18 test role with CREATEDB")
	}
	for key, values := range u.Query() {
		if key != "sslmode" || len(values) != 1 || values[0] != "disable" {
			return nil, errors.New("registry fixture rejects connection routing overrides")
		}
	}
	query := u.Query()
	query.Set("sslmode", "disable")
	query.Set("connect_timeout", "5")
	u.RawQuery = query.Encode()
	u.Path = "/postgres"
	cfg, err := pgxpool.ParseConfig(u.String())
	if err != nil || (cfg.ConnConfig.Host != "127.0.0.1" && cfg.ConnConfig.Host != "::1") {
		return nil, errors.New("registry fixture requires a loopback PostgreSQL 18 test role with CREATEDB")
	}
	cfg.MaxConns = 2
	return cfg, nil
}

func checkRegistryFixture(ctx context.Context, dsn string) (report registryFixtureReport, err error) {
	report = registryFixtureReport{Evidence: "synthetic_fresh_pg18_registry_mechanics_only", Checks: []string{}}
	cfg, err := fixtureAdminConfig(dsn)
	if err != nil {
		return report, err
	}
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return report, errors.New("registry fixture test connection unavailable")
	}
	defer admin.Close()
	var version int
	if admin.QueryRow(ctx, `SELECT current_setting('server_version_num')::int/10000`).Scan(&version) != nil || version != 18 {
		return report, errors.New("registry fixture requires PostgreSQL 18")
	}
	name := "janusly_authoring_check_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted+" TEMPLATE template0"); err != nil {
		return report, errors.New("registry fixture could not create owned database")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if _, dropErr := admin.Exec(cleanup, "DROP DATABASE "+quoted+" WITH (FORCE)"); dropErr != nil {
			err = errors.New("registry fixture could not remove owned database")
		}
	}()
	u, parseErr := url.Parse(dsn)
	if parseErr != nil {
		return report, errors.New("invalid registry fixture test connection")
	}
	u.Path = "/" + name
	query := u.Query()
	query.Set("sslmode", "disable")
	query.Set("connect_timeout", "5")
	u.RawQuery = query.Encode()
	poolConfig, parseErr := pgxpool.ParseConfig(u.String())
	if parseErr != nil || poolConfig.ConnConfig.Database != name || (poolConfig.ConnConfig.Host != "127.0.0.1" && poolConfig.ConnConfig.Host != "::1") {
		return report, errors.New("invalid registry fixture test connection")
	}
	poolConfig.MaxConns = 4
	pool, connectErr := pgxpool.NewWithConfig(ctx, poolConfig)
	if connectErr != nil {
		return report, errors.New("registry fixture test connection unavailable")
	}
	defer pool.Close()
	var connectedDatabase string
	if pool.QueryRow(ctx, `SELECT current_database()`).Scan(&connectedDatabase) != nil || connectedDatabase != name {
		return report, errors.New("registry fixture owned database identity failed")
	}
	if first := migrate.Up(ctx, u.String()); first != nil {
		return report, errors.New("registry fixture migration failed")
	}
	if second := migrate.Up(ctx, u.String()); second != nil {
		return report, errors.New("registry fixture second migration failed")
	}
	report.Checks = append(report.Checks, "fresh_pg18_double_migration")
	catalog := authoring.NewBuilder(nil, nil).Build(ctx, "fixture-a")
	brief := authoring.IntentBrief{Version: "1", Objective: "Prepare local report", Trigger: "manual", Inputs: []string{}, ExpectedOutcome: "Local report", ExternalEffects: []string{}, Approvals: []string{}, FailurePolicy: "stop_and_open_recovery_case", Examples: []string{}, Language: "en"}
	for _, org := range []string{"fixture-a", "fixture-b"} {
		workflow := "workflow-" + org
		if _, err := pool.Exec(ctx, `INSERT INTO workflows(id,org_id,name) VALUES($1,$2,'Fixture report')`, workflow, org); err != nil {
			return report, errors.New("registry fixture seed failed")
		}
		for number := 1; number <= 2; number++ {
			document := map[string]any{"dslVersion": "1.0", "id": workflow, "name": "Fixture report", "nodes": []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}}, "edges": []any{}, "outputs": map[string]string{"report": "{{context.done.output}}"}}
			raw, marshalErr := json.Marshal(document)
			if marshalErr != nil {
				return report, errors.New("registry fixture seed failed")
			}
			versionID := workflow + "-one"
			if number == 2 {
				versionID = workflow + "-two"
			}
			if _, err := pool.Exec(ctx, `INSERT INTO workflow_versions(id,org_id,workflow_id,version,dag_json) VALUES($1,$2,$3,$4,$5)`, versionID, org, workflow, number, raw); err != nil {
				return report, errors.New("registry fixture seed failed")
			}
		}
		for _, entry := range []struct{ key, value, kind string }{{"memory.enabled", "true", "boolean"}, {"ai.authoringExperienceEnabled", "true", "boolean"}, {"memory.allowedKinds", `"workflow_vector"`, "string"}} {
			if _, err := pool.Exec(ctx, `INSERT INTO org_configs(id,org_id,key,value_json,updated_by,category,description,value_type) VALUES($1||':'||$2,$1,$2,$3::jsonb,'fixture-operator',split_part($2,'.',1),'Synthetic fixture',$4)`, org, entry.key, entry.value, entry.kind); err != nil {
				return report, errors.New("registry fixture consent seed failed")
			}
		}
	}
	registry := &authoring.ExperienceRegistry{Pool: pool, Enabled: true}
	request := authoring.DecisionRequest{OrganizationID: "fixture-a", ContextRevision: "fixture-context", CatalogVersion: catalog.Version, Brief: brief, Complete: true}
	disabled := *registry
	disabled.Enabled = false
	if _, err := disabled.Decide(ctx, request, catalog); !errors.Is(err, authoring.ErrExperienceDisabled) {
		return report, errors.New("registry fixture disabled gate failed")
	}
	report.Checks = append(report.Checks, "default_off")
	register := func(id, org, version string) error {
		_, err := registry.Register(ctx, authoring.ExperienceRegistration{ID: id, OrganizationID: org, ActorID: "fixture-operator", WorkflowID: "workflow-" + org, VersionID: version, Brief: brief, Catalog: catalog})
		return err
	}
	if register("experience-a", "fixture-a", "workflow-fixture-a-one") != nil || register("experience-b", "fixture-b", "workflow-fixture-b-one") != nil {
		return report, errors.New("registry fixture registration failed")
	}
	selected, selectErr := registry.Decide(ctx, request, catalog)
	if selectErr != nil || selected.Receipt.Source == nil || selected.Receipt.Mode != authoring.DecisionReuse || selected.Receipt.Source.VersionID != "workflow-fixture-a-one" {
		return report, errors.New("registry fixture exact source failed")
	}
	draft, resolveErr := registry.Resolve(ctx, request, selected.Receipt, catalog, "fixture-draft")
	workflow, issues := domain.Parse(draft)
	if resolveErr != nil || workflow == nil || len(issues) > 0 || workflow.ID != "fixture-draft" {
		return report, errors.New("registry fixture exact copy failed")
	}
	var sourceID string
	if pool.QueryRow(ctx, `SELECT dag_json->>'id' FROM workflow_versions WHERE id='workflow-fixture-a-one'`).Scan(&sourceID) != nil || sourceID != "workflow-fixture-a" {
		return report, errors.New("registry fixture source mutation detected")
	}
	report.Checks = append(report.Checks, "exact_immutable_version_copy")
	adapted := request
	adapted.Edits = []authoring.DescriptiveEdit{{Field: "workflow_name", Value: "Reviewed fixture report"}}
	adaptation, adaptErr := registry.Decide(ctx, adapted, catalog)
	if adaptErr != nil || adaptation.Receipt.Mode != authoring.DecisionAdapt {
		return report, errors.New("registry fixture adaptation failed")
	}
	copy, adaptErr := registry.Resolve(ctx, adapted, adaptation.Receipt, catalog, "fixture-adapted")
	adaptedWorkflow, adaptIssues := domain.Parse(copy)
	if adaptErr != nil || adaptedWorkflow == nil || len(adaptIssues) > 0 || adaptedWorkflow.Name != "Reviewed fixture report" {
		return report, errors.New("registry fixture descriptive copy failed")
	}
	report.Checks = append(report.Checks, "descriptive_adaptation")
	foreign := request
	foreign.OrganizationID = "fixture-b"
	if _, err := registry.Resolve(ctx, foreign, selected.Receipt, catalog, "foreign-draft"); !errors.Is(err, authoring.ErrExperienceSourceUnavailable) {
		return report, errors.New("registry fixture tenant isolation failed")
	}
	report.Checks = append(report.Checks, "tenant_source_isolation")
	unmatched := request
	unmatched.Brief.ExpectedOutcome = "A different local result"
	generated, generateErr := registry.Decide(ctx, unmatched, catalog)
	if generateErr != nil || generated.Receipt.Mode != authoring.DecisionGenerate {
		return report, errors.New("registry fixture generation classification failed")
	}
	unsupported := request
	unsupported.Edits = []authoring.DescriptiveEdit{{Field: "credential", Value: "different"}}
	review, reviewErr := registry.Decide(ctx, unsupported, catalog)
	if reviewErr != nil || review.Receipt.Mode != authoring.DecisionEscalate {
		return report, errors.New("registry fixture escalation failed")
	}
	report.Checks = append(report.Checks, "generate_and_escalate_without_calls")
	if register("experience-a-second", "fixture-a", "workflow-fixture-a-two") != nil {
		return report, errors.New("registry fixture second registration failed")
	}
	if _, err := registry.Resolve(ctx, request, selected.Receipt, catalog, "ambiguous-draft"); !errors.Is(err, authoring.ErrExperienceSourceUnavailable) {
		return report, errors.New("registry fixture stale ambiguity failed")
	}
	if _, _, err := registry.Revoke(ctx, "fixture-a", "experience-a-second"); err != nil {
		return report, errors.New("registry fixture revoke failed")
	}
	report.Checks = append(report.Checks, "new_ambiguity_invalidates_receipt")
	if _, _, err := registry.Revoke(ctx, "fixture-a", "experience-a"); err != nil {
		return report, errors.New("registry fixture revoke failed")
	}
	if _, err := registry.Resolve(ctx, request, selected.Receipt, catalog, "revoked-draft"); !errors.Is(err, authoring.ErrExperienceSourceUnavailable) {
		return report, errors.New("registry fixture revoked source failed")
	}
	report.Checks = append(report.Checks, "revocation_invalidates_receipt")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := registry.Decide(cancelled, request, catalog); !errors.Is(err, context.Canceled) {
		return report, errors.New("registry fixture cancellation failed")
	}
	report.Checks = append(report.Checks, "cancellation_terminal")
	return report, nil
}
