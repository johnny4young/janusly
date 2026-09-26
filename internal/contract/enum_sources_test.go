package contract

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
)

// emitSite names where production files write a vocabulary value: keyed
// fields and assigned variables by name, and function arguments by position.
type emitSite struct {
	glob  string
	names []string
	calls map[string]int
}

// literals returns every string literal the site's production files emit.
func (site emitSite) literals(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(site.glob)
	if err != nil || len(files) == 0 {
		t.Fatalf("no Go files match %s: %v", site.glob, err)
	}
	var found []string
	collect := func(expr ast.Expr) {
		if lit, ok := expr.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			value, err := strconv.Unquote(lit.Value)
			if err != nil {
				t.Fatal(err)
			}
			found = append(found, value)
		}
	}
	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch node := node.(type) {
			case *ast.KeyValueExpr:
				if key, ok := node.Key.(*ast.Ident); ok && slices.Contains(site.names, key.Name) {
					collect(node.Value)
				}
			case *ast.AssignStmt:
				for i, lhs := range node.Lhs {
					if name, ok := lhs.(*ast.Ident); ok && slices.Contains(site.names, name.Name) && i < len(node.Rhs) {
						collect(node.Rhs[i])
					}
				}
			case *ast.CallExpr:
				if fn, ok := node.Fun.(*ast.Ident); ok {
					if index, ok := site.calls[fn.Name]; ok && index < len(node.Args) {
						collect(node.Args[index])
					}
				}
			}
			return true
		})
	}
	return found
}

// A manifest enum is built from a Go list; every literal the server writes
// into that field must be in the list, or a browser guard rejects a real response.
func TestEnumListsCoverEmittedValues(t *testing.T) {
	cases := []struct {
		name    string
		list    []string
		sites   []emitSite
		allowed []string
	}{
		{"recovery case state", domain.RecoveryCaseStates, []emitSite{{
			glob: "../engine/*.go", names: []string{"State", "FromState", "ToState", "state", "finalState", "resultState"},
		}}, nil},
		{"recovery actor kind", domain.RecoveryCaseActorKinds, []emitSite{{
			glob: "../engine/*.go", names: []string{"ActorKind", "actorKind"},
		}}, nil},
		{"rollout status", domain.WorkflowRolloutStatuses, []emitSite{{
			glob: "../engine/*.go", names: []string{"NewStatus", "newStatus"},
		}}, nil},
		{"qualification failure dataset", recovery.QualificationFailureDatasets, []emitSite{{
			glob: "../recovery/*.go", names: []string{"Dataset", "dataset"}, calls: map[string]int{"evaluateDataset": 0},
		}}, nil},
		{"qualification failure reason", recovery.QualificationFailureReasons, []emitSite{{
			glob: "../recovery/*.go", names: []string{"Reason", "reason"},
		}}, nil},
		{"failure cluster category", signature.Categories, []emitSite{{
			glob: "../signature/*.go", names: []string{"Category"},
		}}, nil},
		{"failure cluster owner", signature.Owners, []emitSite{{
			glob: "../signature/*.go", names: []string{"SuggestedOwner"},
		}}, nil},
		{"autonomy source", domain.RecoveryAutonomySources, []emitSite{{
			glob: "../domain/recoveryautonomy.go", names: []string{"source"}, calls: map[string]int{"autonomyProfile": 1},
		}}, nil},
		// An empty reason means the profile is available and serializes as null.
		{"autonomy unavailable reason", domain.RecoveryAutonomyUnavailableReasons, []emitSite{{
			glob: "../domain/recoveryautonomy.go", names: []string{"reason"}, calls: map[string]int{"autonomyProfile": 3},
		}}, []string{""}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			seen := 0
			for _, site := range tc.sites {
				for _, value := range site.literals(t) {
					seen++
					if !slices.Contains(tc.list, value) && !slices.Contains(tc.allowed, value) {
						t.Errorf("%s emits %q, which its enum list %v does not declare", site.glob, value, tc.list)
					}
				}
			}
			if seen == 0 {
				t.Fatal("no emit site found; the scan no longer matches the code")
			}
		})
	}
}

// The database constrains these columns; the enum must admit exactly what the CHECK admits.
func TestEnumListsMatchDatabaseChecks(t *testing.T) {
	baseline, err := os.ReadFile("../migrate/sql/00001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	for name, list := range map[string][]string{
		"recovery_case_artifacts_kind_check":  domain.RecoveryCaseArtifactKinds,
		"recovery_case_artifacts_actor_check": domain.RecoveryCaseActorKinds,
	} {
		check := regexp.MustCompile(`CONSTRAINT ` + name + ` CHECK \(\(\w+ = ANY \(ARRAY\[([^\]]*)\]\)\)\)`).FindSubmatch(baseline)
		if check == nil {
			t.Fatalf("%s not found in the baseline", name)
		}
		var admitted []string
		for _, match := range regexp.MustCompile(`'(\w+)'::text`).FindAllSubmatch(check[1], -1) {
			admitted = append(admitted, string(match[1]))
		}
		if !slices.Equal(slices.Sorted(slices.Values(admitted)), slices.Sorted(slices.Values(list))) {
			t.Errorf("%s admits %v, enum list is %v", name, admitted, list)
		}
	}
}

// Rollout rows are written by SQL literals as well as the engine.
func TestRolloutStatusSQLLiteralsAreDeclared(t *testing.T) {
	queries, err := os.ReadFile("../store/queries/workflows.sql")
	if err != nil {
		t.Fatal(err)
	}
	literal := regexp.MustCompile(`(?:^|[^.\w]|\bwr\.)status = '(\w+)'`)
	seen := 0
	for statement := range strings.SplitSeq(string(queries), "-- name:") {
		if !strings.Contains(statement, "workflow_rollouts") {
			continue
		}
		for _, match := range literal.FindAllStringSubmatch(statement, -1) {
			seen++
			if !slices.Contains(domain.WorkflowRolloutStatuses, match[1]) {
				t.Errorf("workflow_rollouts query uses status %q, which the enum does not declare", match[1])
			}
		}
	}
	if seen == 0 {
		t.Fatal("no rollout status literal found; the scan no longer matches the queries")
	}
}
