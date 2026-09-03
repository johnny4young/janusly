//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func workflowSloDeclaration(successRatePercent float64) map[string]any {
	return map[string]any{
		"successRatePercent": successRatePercent,
		"mttrSeconds":        nil, "p95DurationMs": nil,
		"budgetBlocksPerWindow": nil, "stuckWaitingNodesMax": nil,
		"windowDays": 7,
	}
}

func TestWorkflowSavePersistsCanonicalSnapshotAndCarriesReliability(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := t.Context()

	first := map[string]any{
		"metadata": map[string]any{
			"description": "  PagerDuty assurance  ",
			"tags":        []any{"  pagerduty  "},
			"owner":       "strip-me",
		},
		"ui": map[string]any{
			"positions": map[string]any{"trigger": map[string]any{"x": 12.5, "y": -3.0, "z": 9}},
			"theme":     "strip-me",
		},
		"upstreamHealthSources": []any{"  pagerduty-api  "},
		"nodes": []any{
			map[string]any{"id": " trigger ", "type": "noop", "config": map[string]any{"kept": true}, "unknown": "strip-me"},
		},
		"edges": []any{},
	}
	created := h.call(http.MethodPost, "/v1/workflows/save", first, "")
	if created.status != http.StatusOK {
		t.Fatalf("first save: %d %+v", created.status, created.body)
	}
	createdData := created.body["data"].(map[string]any)
	workflowID := createdData["workflowId"].(string)

	var parentName string
	var dagRaw, sloRaw, upstreamRaw []byte
	if err := pool.QueryRow(ctx, `
		SELECT w.name, wv.dag_json, wv.slo_json, wv.upstream_health_sources
		FROM workflows w
		JOIN workflow_versions wv ON wv.org_id=w.org_id AND wv.workflow_id=w.id
		WHERE w.org_id=$1 AND w.id=$2 AND wv.version=1`, h.org, workflowID).
		Scan(&parentName, &dagRaw, &sloRaw, &upstreamRaw); err != nil {
		t.Fatal(err)
	}
	if parentName != workflowID {
		t.Fatalf("generated name must be persisted consistently: name=%q id=%q", parentName, workflowID)
	}
	var dag map[string]any
	if err := json.Unmarshal(dagRaw, &dag); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"mystery", "slo", "upstreamHealthSources"} {
		if _, present := dag[forbidden]; present {
			t.Fatalf("canonical DAG retained %q: %s", forbidden, dagRaw)
		}
	}
	if dag["dslVersion"] != "1.0" || dag["id"] != workflowID || dag["name"] != workflowID {
		t.Fatalf("canonical identity/default mismatch: %s", dagRaw)
	}
	metadata := dag["metadata"].(map[string]any)
	if metadata["description"] != "PagerDuty assurance" || metadata["tags"].([]any)[0] != "pagerduty" {
		t.Fatalf("metadata normalization mismatch: %+v", metadata)
	}
	if _, present := metadata["owner"]; present {
		t.Fatalf("unknown inline metadata survived: %+v", metadata)
	}
	if len(sloRaw) != 0 {
		t.Fatalf("new workflow must not invent an SLO: %s", sloRaw)
	}
	if string(upstreamRaw) != `["pagerduty-api"]` {
		t.Fatalf("upstream carrier must be normalized: %s", upstreamRaw)
	}
	declared := h.call(http.MethodPost, "/workflows/"+workflowID+"/slo", map[string]any{
		"slo": workflowSloDeclaration(99.0),
	}, "")
	if declared.status != http.StatusOK {
		t.Fatalf("declare SLO through admin chokepoint: %d %+v", declared.status, declared.body)
	}

	second := map[string]any{
		"id": workflowID, "name": "Renamed assurance",
		"nodes": []any{map[string]any{"id": "trigger", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	updated := h.call(http.MethodPost, "/v1/workflows/save", second, "")
	if updated.status != http.StatusOK || updated.body["data"].(map[string]any)["version"] != float64(2) {
		t.Fatalf("second save: %d %+v", updated.status, updated.body)
	}
	if err := pool.QueryRow(ctx, `
		SELECT w.name, wv.dag_json, wv.slo_json, wv.upstream_health_sources
		FROM workflows w
		JOIN workflow_versions wv ON wv.org_id=w.org_id AND wv.workflow_id=w.id
		WHERE w.org_id=$1 AND w.id=$2 AND wv.version=2`, h.org, workflowID).
		Scan(&parentName, &dagRaw, &sloRaw, &upstreamRaw); err != nil {
		t.Fatal(err)
	}
	if parentName != "Renamed assurance" {
		t.Fatalf("parent name did not follow canonical snapshot: %q", parentName)
	}
	if string(sloRaw) == "" || string(upstreamRaw) != `["pagerduty-api"]` {
		t.Fatalf("absent carriers must inherit the latest declarations: slo=%s upstream=%s", sloRaw, upstreamRaw)
	}
	dag = nil
	if string(dagRaw) == "" || json.Unmarshal(dagRaw, &dag) != nil || dag["name"] != "Renamed assurance" {
		t.Fatalf("renamed canonical snapshot mismatch: %s", dagRaw)
	}

	invalidFields := []struct {
		field string
		value any
	}{
		{"upstreamHealthSources", nil},
		{"upstreamHealthSources", "not-an-array"},
		{"slo", map[string]any{"windowDays": 7}},
		{"mystery", true},
	}
	for _, candidate := range invalidFields {
		invalid := map[string]any{
			"id": workflowID, candidate.field: candidate.value,
			"nodes": []any{map[string]any{"id": "trigger", "type": "noop", "config": map[string]any{}}},
			"edges": []any{},
		}
		if rejected := h.call(http.MethodPost, "/v1/workflows/save", invalid, ""); rejected.status != http.StatusBadRequest {
			t.Fatalf("invalid save field %s must fail: %d %+v", candidate.field, rejected.status, rejected.body)
		}
	}
	var versions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_versions WHERE org_id=$1 AND workflow_id=$2`, h.org, workflowID).Scan(&versions); err != nil || versions != 2 {
		t.Fatalf("rejected save mutated history: versions=%d err=%v", versions, err)
	}
}

func TestWorkflowSloMutationSharesVersionSerializationLock(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := t.Context()
	workflowID := fmt.Sprintf("wf-slo-lock-%d", time.Now().UnixNano())
	document := map[string]any{
		"id":    workflowID,
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if saved := h.call(http.MethodPost, "/v1/workflows/save", document, ""); saved.status != http.StatusOK {
		t.Fatalf("save: %d %+v", saved.status, saved.body)
	}

	lock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Rollback(ctx) }()
	if _, err := lock.Exec(ctx, `SELECT id FROM workflows WHERE org_id=$1 AND id=$2 FOR UPDATE`, h.org, workflowID); err != nil {
		t.Fatal(err)
	}

	responses := make(chan apiResponse, 1)
	go func() {
		responses <- h.call(http.MethodPost, "/workflows/"+workflowID+"/slo", map[string]any{
			"slo": workflowSloDeclaration(99.5),
		}, "")
	}()
	select {
	case response := <-responses:
		t.Fatalf("SLO mutation bypassed the workflow serialization lock: %d %+v", response.status, response.body)
	case <-time.After(250 * time.Millisecond):
	}
	if err := lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-responses:
		if response.status != http.StatusOK {
			t.Fatalf("serialized SLO mutation failed: %d %+v", response.status, response.body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serialized SLO mutation did not resume after parent lock release")
	}
	var sloRaw []byte
	if err := pool.QueryRow(ctx, `
		SELECT slo_json FROM workflow_versions
		WHERE org_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1`, h.org, workflowID).Scan(&sloRaw); err != nil {
		t.Fatal(err)
	}
	var slo map[string]any
	if json.Unmarshal(sloRaw, &slo) != nil || slo["successRatePercent"] != 99.5 {
		t.Fatalf("latest version did not receive serialized SLO: %s", sloRaw)
	}
}

func TestWorkflowRestoreRollsBackWhenLatestSnapshotIsMalformed(t *testing.T) {
	for _, testCase := range []struct {
		name, dag, code string
		status          int
	}{
		{name: "wire malformed", dag: `{"nodes":null,"edges":[]}`, status: http.StatusUnprocessableEntity, code: "workflows_version_malformed"},
		{name: "schedule malformed", dag: `{"nodes":[{"id":"s","type":"schedule","config":{}}],"edges":[]}`, status: http.StatusInternalServerError, code: "internal_error"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			h := newAPIHarnessWithoutWorkers(t)
			pool := testPool(t)
			workflowID := fmt.Sprintf("wf-restore-atomic-%d", time.Now().UnixNano())
			if saved := h.call(http.MethodPost, "/v1/workflows/save", map[string]any{
				"id":    workflowID,
				"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
				"edges": []any{},
			}, ""); saved.status != http.StatusOK {
				t.Fatalf("save: %d %+v", saved.status, saved.body)
			}
			if _, err := pool.Exec(t.Context(), `
				UPDATE workflow_versions SET dag_json=$3::jsonb
				WHERE org_id=$1 AND workflow_id=$2`, h.org, workflowID, testCase.dag); err != nil {
				t.Fatal(err)
			}
			if deleted := h.call(http.MethodDelete, "/workflows/"+workflowID, nil, ""); deleted.status != http.StatusOK {
				t.Fatalf("delete: %d %+v", deleted.status, deleted.body)
			}
			restored := h.call(http.MethodPost, "/workflows/"+workflowID+"/restore", nil, "")
			if restored.status != testCase.status || restored.body["code"] != testCase.code {
				t.Fatalf("malformed restore must fail closed: %d %+v", restored.status, restored.body)
			}
			var remainsDeleted bool
			if err := pool.QueryRow(t.Context(), `
				SELECT deleted_at IS NOT NULL FROM workflows WHERE org_id=$1 AND id=$2`, h.org, workflowID).
				Scan(&remainsDeleted); err != nil || !remainsDeleted {
				t.Fatalf("failed restore exposed an active workflow: deleted=%v err=%v", remainsDeleted, err)
			}
		})
	}
}

func TestConcurrentWorkflowSavesSerializeWithoutLostVersions(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := t.Context()
	workflowID := fmt.Sprintf("wf-concurrent-save-%d", time.Now().UnixNano())
	document := map[string]any{
		"id": workflowID, "name": "Concurrent assurance",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}

	const writers = 12
	responses := make(chan apiResponse, writers)
	var group sync.WaitGroup
	group.Add(writers)
	for range writers {
		go func() {
			defer group.Done()
			responses <- h.call(http.MethodPost, "/v1/workflows/save", document, "")
		}()
	}
	group.Wait()
	close(responses)
	seenVersions := make(map[int]bool, writers)
	for response := range responses {
		if response.status != http.StatusOK {
			t.Fatalf("concurrent save did not converge: %d %+v", response.status, response.body)
		}
		version := int(response.body["data"].(map[string]any)["version"].(float64))
		seenVersions[version] = true
	}
	if len(seenVersions) != writers {
		t.Fatalf("version responses were not unique: %+v", seenVersions)
	}
	for version := 1; version <= writers; version++ {
		if !seenVersions[version] {
			t.Fatalf("missing version %d from concurrent saves: %+v", version, seenVersions)
		}
	}
	var count, minimum, maximum int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), min(version), max(version)
		FROM workflow_versions WHERE org_id=$1 AND workflow_id=$2`, h.org, workflowID).
		Scan(&count, &minimum, &maximum); err != nil {
		t.Fatal(err)
	}
	if count != writers || minimum != 1 || maximum != writers {
		t.Fatalf("durable version sequence mismatch: count=%d min=%d max=%d", count, minimum, maximum)
	}
}

func TestWorkflowRollbackAtomicallyRestoresSchedulesAndReliability(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "wf-rollback-schedule-" + suffix
	withSchedule := map[string]any{
		"id":                    workflowID,
		"upstreamHealthSources": []any{"pagerduty-api"},
		"nodes": []any{map[string]any{
			"id": "hourly", "type": "schedule",
			"config": map[string]any{"cronExpression": "0 * * * *", "enabled": true},
		}},
		"edges": []any{},
	}
	first := h.call(http.MethodPost, "/v1/workflows/save", withSchedule, "")
	if first.status != http.StatusOK {
		t.Fatalf("save scheduled v1: %d %+v", first.status, first.body)
	}
	firstVersionID := first.body["data"].(map[string]any)["versionId"].(string)
	// Simulate a pre-canonical historical snapshot. Rollback may restore its
	// behavior, but must not republish unknown carrier fields as a new version.
	if _, err := pool.Exec(ctx, `
		UPDATE workflow_versions
		SET dag_json = dag_json || '{"legacyCarrier":"strip-on-rollback"}'::jsonb
		WHERE org_id=$1 AND workflow_id=$2 AND id=$3`, h.org, workflowID, firstVersionID); err != nil {
		t.Fatal(err)
	}
	declared := h.call(http.MethodPost, "/workflows/"+workflowID+"/slo", map[string]any{
		"slo": workflowSloDeclaration(98.0),
	}, "")
	if declared.status != http.StatusOK {
		t.Fatalf("declare rollback SLO: %d %+v", declared.status, declared.body)
	}
	withoutSchedule := map[string]any{
		"id":    workflowID,
		"nodes": []any{map[string]any{"id": "plain", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if second := h.call(http.MethodPost, "/v1/workflows/save", withoutSchedule, ""); second.status != http.StatusOK {
		t.Fatalf("save unscheduled v2: %d %+v", second.status, second.body)
	}
	var entries int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schedule_entries WHERE org_id=$1 AND workflow_id=$2`, h.org, workflowID).Scan(&entries); err != nil || entries != 0 {
		t.Fatalf("v2 must remove the old schedule: entries=%d err=%v", entries, err)
	}

	rolled := h.call(http.MethodPost, "/workflows/rollback", map[string]any{
		"workflowId": workflowID, "sourceVersionId": firstVersionID,
	}, "")
	if rolled.status != http.StatusOK || rolled.body["version"] != float64(3) {
		t.Fatalf("rollback: %d %+v", rolled.status, rolled.body)
	}
	rollbackVersionID := rolled.body["versionId"].(string)
	var scheduledVersionID string
	if err := pool.QueryRow(ctx, `
		SELECT workflow_version_id FROM schedule_entries
		WHERE org_id=$1 AND workflow_id=$2 AND node_id='hourly'`, h.org, workflowID).
		Scan(&scheduledVersionID); err != nil {
		t.Fatal(err)
	}
	if scheduledVersionID != rollbackVersionID {
		t.Fatalf("schedule does not point at committed rollback: got=%s want=%s", scheduledVersionID, rollbackVersionID)
	}
	var rollbackDagRaw, sloRaw, upstreamRaw []byte
	if err := pool.QueryRow(ctx, `
		SELECT dag_json, slo_json, upstream_health_sources FROM workflow_versions
		WHERE org_id=$1 AND workflow_id=$2 AND id=$3`, h.org, workflowID, rollbackVersionID).
		Scan(&rollbackDagRaw, &sloRaw, &upstreamRaw); err != nil {
		t.Fatal(err)
	}
	if len(sloRaw) == 0 || string(upstreamRaw) != `["pagerduty-api"]` {
		t.Fatalf("rollback cleared current reliability declarations: slo=%s upstream=%s", sloRaw, upstreamRaw)
	}
	if strings.Contains(string(rollbackDagRaw), "legacyCarrier") {
		t.Fatalf("rollback republished an unknown historical carrier: %s", rollbackDagRaw)
	}
}
