package engine

import (
	"os"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestCloneRuntimeFailureWorkflow(t *testing.T) {
	workflow := &domain.Workflow{
		Nodes: []domain.Node{
			{ID: "root", Type: "noop", Config: map[string]any{}},
			{ID: "classify", Type: "noop", Config: map[string]any{}},
			{ID: "target", Type: "tool", Config: map[string]any{"tool": "github.create_issue"}},
			{ID: "after", Type: "noop", Config: map[string]any{}},
		},
		Edges: []domain.Edge{
			{From: "root", To: "classify"},
			{From: "classify", To: "target"},
			{From: "target", To: "after"},
		},
	}
	cloned, ancestors, err := cloneRuntimeFailureWorkflow(workflow, "target")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if len(ancestors) != 2 || !ancestors["root"] || !ancestors["classify"] || ancestors["after"] {
		t.Fatalf("ancestor closure is wrong: %+v", ancestors)
	}
	if cloned.Nodes[2].Config[runtimeDrillProbeKey] != "{{secret."+runtimeDrillSecretName+"}}" ||
		cloned.Nodes[2].Config["tool"] != "github.create_issue" {
		t.Fatalf("target probe/config was not preserved: %+v", cloned.Nodes[2].Config)
	}
	if _, mutated := workflow.Nodes[2].Config[runtimeDrillProbeKey]; mutated {
		t.Fatal("preparing a drill must not mutate the catalog workflow")
	}
	if _, _, err := cloneRuntimeFailureWorkflow(workflow, "missing"); err == nil {
		t.Fatal("unknown target must fail before persistence")
	}
}

func TestRuntimeFailureDrillRejectsConfiguredProbe(t *testing.T) {
	previous, present := os.LookupEnv(runtimeDrillSecretName)
	if err := os.Setenv(runtimeDrillSecretName, "must-not-run"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if present {
			_ = os.Setenv(runtimeDrillSecretName, previous)
		} else {
			_ = os.Unsetenv(runtimeDrillSecretName)
		}
	})
	_, err := (&Engine{}).RunRuntimeFailureDrill(t.Context(), RecoveryDrillInput{})
	if err == nil {
		t.Fatal("a configured reserved secret must fail closed")
	}
}
