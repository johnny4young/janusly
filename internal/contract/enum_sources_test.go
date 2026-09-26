package contract

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"

	"github.com/johnny4young/janusly/internal/aievidence"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
)

const modulePath = "github.com/johnny4young/janusly/"

// fieldDest is a struct field that carries a vocabulary value to the wire or a row.
type fieldDest struct{ pkg, typ, field string }

// mapDest is a JSON map key, recognized by a sibling key in the same literal.
type mapDest struct{ key, sibling string }

// vocabulary is a manifest enum list and every Go and SQL place that writes it.
type vocabulary struct {
	name    string
	list    []string
	fields  []fieldDest
	maps    []mapDest
	columns []sqlColumn
	// allowed values are written but never reach the enum (an empty reason serializes as null).
	allowed []string
	// noGoLiteral and noSQLLiteral mark vocabularies that only flow from
	// validated input or bound parameters, so the scan expects no literal.
	noGoLiteral, noSQLLiteral bool
}

type sqlColumn struct{ table, column string }

func fields(pkg, typ string, names ...string) []fieldDest {
	out := make([]fieldDest, len(names))
	for i, name := range names {
		out[i] = fieldDest{pkg, typ, name}
	}
	return out
}

func vocabularies() []vocabulary {
	store := "internal/store"
	return []vocabulary{
		{name: "recovery case state", list: domain.RecoveryCaseStates, fields: slices.Concat(
			fields(store, "InsertRecoveryCaseParams", "State"),
			fields(store, "RecoveryCase", "State"),
			fields(store, "InsertRecoveryCaseTransitionParams", "FromState", "ToState"),
			fields(store, "RecoveryCaseTransition", "FromState", "ToState"),
			fields(store, "AdvanceRecoveryCaseStateAtRevisionParams", "FromState", "ToState"),
			fields(store, "TransitionRecoveryCaseStateParams", "FromState", "ToState"),
			fields("internal/engine", "RecoveryTransitionStep", "From", "To"),
			fields("internal/domain", "RecoveryCaseTransitionReceipt", "From", "To"),
		), columns: []sqlColumn{
			{"recovery_cases", "state"},
			{"recovery_case_transitions", "from_state"}, {"recovery_case_transitions", "to_state"},
		}},
		{name: "recovery case action", list: domain.RecoveryDetectorActions, fields: slices.Concat(
			fields(store, "InsertRecoveryCaseParams", "Action"),
			fields(store, "RecoveryCase", "Action"),
			fields("internal/engine", "RecoveryCaseInput", "Action"),
		), columns: []sqlColumn{{"recovery_cases", "action"}}, noGoLiteral: true},
		{name: "recovery actor kind", list: domain.RecoveryCaseActorKinds, fields: slices.Concat(
			fields(store, "InsertRecoveryCaseTransitionParams", "ActorKind"),
			fields(store, "InsertRecoveryCaseArtifactParams", "ActorKind"),
			fields("internal/domain", "RecoveryCaseTransitionReceipt", "ActorKind"),
		), columns: []sqlColumn{
			{"recovery_case_transitions", "actor_kind"}, {"recovery_case_artifacts", "actor_kind"},
		}, noSQLLiteral: true},
		{name: "recovery artifact kind", list: domain.RecoveryCaseArtifactKinds,
			fields:  fields(store, "InsertRecoveryCaseArtifactParams", "Kind"),
			columns: []sqlColumn{{"recovery_case_artifacts", "kind"}}, noSQLLiteral: true},
		{name: "rollout status", list: domain.WorkflowRolloutStatuses, fields: slices.Concat(
			fields(store, "FinishWorkflowRolloutCASParams", "NewStatus"),
			fields(store, "WorkflowRollout", "Status"),
		), columns: []sqlColumn{{"workflow_rollouts", "status"}}},
		{name: "qualification failure dataset", list: recovery.QualificationFailureDatasets,
			fields: fields("internal/recovery", "QualificationFailure", "Dataset")},
		{name: "qualification failure reason", list: recovery.QualificationFailureReasons,
			fields: fields("internal/recovery", "QualificationFailure", "Reason")},
		{name: "AI evidence kind", list: aievidence.KindList,
			fields: fields("internal/aievidence", "Row", "Kind"),
			maps:   []mapDest{{key: "kind", sibling: "snippet"}}},
		{name: "failure cluster category", list: signature.Categories, fields: slices.Concat(
			fields("internal/signature", "Result", "Category"),
			fields("internal/signature", "FailureCluster", "Category"),
		)},
		{name: "failure cluster owner", list: signature.Owners, fields: slices.Concat(
			fields("internal/signature", "Result", "SuggestedOwner"),
			fields("internal/signature", "FailureCluster", "SuggestedOwner"),
		)},
		{name: "autonomy source", list: domain.RecoveryAutonomySources,
			fields: fields("internal/domain", "RecoveryAutonomyProfile", "Source")},
		{name: "autonomy unavailable reason", list: domain.RecoveryAutonomyUnavailableReasons,
			fields: fields("internal/domain", "RecoveryAutonomyProfile", "UnavailableReason"), allowed: []string{""}},
	}
}

// valueIndex resolves the constant strings an expression can hold: literals,
// constants from any package, local variables through every assignment, and
// parameters and function results through every call site in the loaded code.
type valueIndex struct {
	info    map[*ast.File]*types.Info
	assigns map[types.Object][]ast.Expr
	params  map[types.Object]paramSlot
	calls   map[string][]*ast.CallExpr
	returns map[string][]ast.Expr
	fileOf  map[ast.Node]*ast.File
}

type paramSlot struct {
	fn    string
	index int
}

// funcKey names a function the same way in every package, whether its types
// came from source or export data; a closure is keyed by its variable.
func funcKey(obj types.Object) string {
	if fn, ok := obj.(*types.Func); ok {
		return fn.FullName()
	}
	if obj == nil || obj.Pkg() == nil {
		return ""
	}
	return obj.Pkg().Path() + "#" + obj.Name() + "@" + strconv.Itoa(int(obj.Pos()))
}

func (index *valueIndex) callee(info *types.Info, call *ast.CallExpr) types.Object {
	switch fn := ast.Unparen(call.Fun).(type) {
	case *ast.Ident:
		return info.Uses[fn]
	case *ast.SelectorExpr:
		return info.Uses[fn.Sel]
	}
	return nil
}

func (index *valueIndex) add(file *ast.File, info *types.Info) {
	index.info[file] = info
	bindParams := func(key string, params *ast.FieldList) {
		position := 0
		for _, field := range params.List {
			names := field.Names
			if len(names) == 0 {
				position++
				continue
			}
			for _, name := range names {
				if obj := info.Defs[name]; obj != nil {
					index.params[obj] = paramSlot{key, position}
					index.fileOf[name] = file
				}
				position++
			}
		}
	}
	var enclosing []string
	ast.Inspect(file, func(node ast.Node) bool {
		switch node := node.(type) {
		case *ast.FuncDecl:
			key := funcKey(info.Defs[node.Name])
			bindParams(key, node.Type.Params)
			if node.Body != nil {
				ast.Inspect(node.Body, func(inner ast.Node) bool {
					if _, nested := inner.(*ast.FuncLit); nested {
						return false
					}
					if ret, ok := inner.(*ast.ReturnStmt); ok && len(ret.Results) > 0 {
						index.returns[key] = append(index.returns[key], ret.Results[0])
						index.fileOf[ret.Results[0]] = file
					}
					return true
				})
			}
			enclosing = append(enclosing, key)
		case *ast.AssignStmt:
			if len(node.Lhs) != len(node.Rhs) {
				return true
			}
			for i, lhs := range node.Lhs {
				ident, ok := lhs.(*ast.Ident)
				if !ok {
					continue
				}
				obj := info.ObjectOf(ident)
				if obj == nil {
					continue
				}
				index.assigns[obj] = append(index.assigns[obj], node.Rhs[i])
				index.fileOf[node.Rhs[i]] = file
				if lit, ok := node.Rhs[i].(*ast.FuncLit); ok {
					bindParams(funcKey(obj), lit.Type.Params)
				}
			}
		case *ast.ValueSpec:
			for i, name := range node.Names {
				if i < len(node.Values) {
					obj := info.Defs[name]
					index.assigns[obj] = append(index.assigns[obj], node.Values[i])
					index.fileOf[node.Values[i]] = file
				}
			}
		case *ast.CallExpr:
			if obj := index.callee(info, node); obj != nil {
				key := funcKey(obj)
				index.calls[key] = append(index.calls[key], node)
				index.fileOf[node] = file
			}
		}
		return true
	})
}

// resolve returns the constant strings expr can hold; unknown sources (field
// reads, decoded input) contribute nothing.
func (index *valueIndex) resolve(file *ast.File, expr ast.Expr, seen map[ast.Node]bool) []string {
	if seen[expr] {
		return nil
	}
	seen[expr] = true
	info := index.info[file]
	if tv, ok := info.Types[expr]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		return []string{constant.StringVal(tv.Value)}
	}
	switch expr := ast.Unparen(expr).(type) {
	case *ast.Ident:
		obj := info.Uses[expr]
		var out []string
		for _, value := range index.assigns[obj] {
			out = append(out, index.resolve(index.fileOf[value], value, seen)...)
		}
		if slot, ok := index.params[obj]; ok {
			for _, call := range index.calls[slot.fn] {
				if slot.index < len(call.Args) {
					out = append(out, index.resolve(index.fileOf[call], call.Args[slot.index], seen)...)
				}
			}
		}
		return out
	case *ast.CallExpr:
		if builtin, ok := index.callee(info, expr).(*types.Builtin); ok && builtin.Name() == "new" && len(expr.Args) == 1 {
			return index.resolve(file, expr.Args[0], seen)
		}
		var out []string
		for _, result := range index.returns[funcKey(index.callee(info, expr))] {
			out = append(out, index.resolve(index.fileOf[result], result, seen)...)
		}
		return out
	case *ast.UnaryExpr:
		if expr.Op == token.AND {
			return index.resolve(file, expr.X, seen)
		}
	}
	return nil
}

func loadInternal(t *testing.T) []*packages.Package {
	t.Helper()
	pkgs, err := packages.Load(&packages.Config{
		Dir:  "../..",
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes | packages.NeedTypesInfo,
	}, "./internal/...")
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range pkgs {
		for _, loadErr := range pkg.Errors {
			t.Fatalf("load %s: %v", pkg.PkgPath, loadErr)
		}
	}
	return pkgs
}

// structField names the (package, type, field) an assignment or keyed element targets.
func structField(t types.Type, field string) (fieldDest, bool) {
	if pointer, ok := t.Underlying().(*types.Pointer); ok {
		t = pointer.Elem()
	}
	named, ok := types.Unalias(t).(*types.Named)
	if !ok || named.Obj().Pkg() == nil {
		return fieldDest{}, false
	}
	return fieldDest{strings.TrimPrefix(named.Obj().Pkg().Path(), modulePath), named.Obj().Name(), field}, true
}

type emitted struct {
	value string
	pos   token.Position
}

// emittedValues maps every destination of every vocabulary to the constant
// strings the production code writes there.
func emittedValues(t *testing.T, vocabs []vocabulary) map[string][]emitted {
	t.Helper()
	index := &valueIndex{
		info: map[*ast.File]*types.Info{}, assigns: map[types.Object][]ast.Expr{},
		params: map[types.Object]paramSlot{}, calls: map[string][]*ast.CallExpr{},
		returns: map[string][]ast.Expr{}, fileOf: map[ast.Node]*ast.File{},
	}
	pkgs := loadInternal(t)
	for _, pkg := range pkgs {
		for _, file := range pkg.Syntax {
			index.add(file, pkg.TypesInfo)
		}
	}
	owner := map[fieldDest]string{}
	mapOwner := map[mapDest]string{}
	for _, vocab := range vocabs {
		for _, dest := range vocab.fields {
			owner[dest] = vocab.name
		}
		for _, dest := range vocab.maps {
			mapOwner[dest] = vocab.name
		}
	}
	found := map[string][]emitted{}
	record := func(pkg *packages.Package, file *ast.File, name string, value ast.Expr) {
		for _, text := range index.resolve(file, value, map[ast.Node]bool{}) {
			found[name] = append(found[name], emitted{text, pkg.Fset.Position(value.Pos())})
		}
	}
	for _, pkg := range pkgs {
		info := pkg.TypesInfo
		for _, file := range pkg.Syntax {
			ast.Inspect(file, func(node ast.Node) bool {
				switch node := node.(type) {
				case *ast.CompositeLit:
					typ := info.TypeOf(node)
					if typ == nil {
						return true
					}
					keys := map[string]ast.Expr{}
					for _, element := range node.Elts {
						kv, ok := element.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						switch key := kv.Key.(type) {
						case *ast.Ident:
							if dest, ok := structField(typ, key.Name); ok && owner[dest] != "" {
								record(pkg, file, owner[dest], kv.Value)
							}
						case *ast.BasicLit:
							if key.Kind == token.STRING {
								keys[strings.Trim(key.Value, "`\"")] = kv.Value
							}
						}
					}
					for dest, name := range mapOwner {
						if value, ok := keys[dest.key]; ok {
							if _, sibling := keys[dest.sibling]; sibling {
								record(pkg, file, name, value)
							}
						}
					}
				case *ast.AssignStmt:
					if len(node.Lhs) != len(node.Rhs) {
						return true
					}
					for i, lhs := range node.Lhs {
						selector, ok := lhs.(*ast.SelectorExpr)
						if !ok {
							continue
						}
						selection := info.Selections[selector]
						if selection == nil || selection.Kind() != types.FieldVal {
							continue
						}
						if dest, ok := structField(selection.Recv(), selector.Sel.Name); ok && owner[dest] != "" {
							record(pkg, file, owner[dest], node.Rhs[i])
						}
					}
				}
				return true
			})
		}
	}
	return found
}

// A manifest enum is built from a Go list; every constant the server writes
// into that field must be in the list, or a browser guard rejects a real response.
func TestEnumListsCoverEmittedValues(t *testing.T) {
	vocabs := vocabularies()
	found := emittedValues(t, vocabs)
	for _, vocab := range vocabs {
		t.Run(vocab.name, func(t *testing.T) {
			if !vocab.noGoLiteral && len(found[vocab.name]) == 0 {
				t.Fatal("no emit site found; the destinations no longer match the code")
			}
			for _, item := range found[vocab.name] {
				if !slices.Contains(vocab.list, item.value) && !slices.Contains(vocab.allowed, item.value) {
					t.Errorf("%s writes %q, which the enum list %v does not declare", item.pos, item.value, vocab.list)
				}
			}
		})
	}
}

var (
	sqlStatementName = regexp.MustCompile(`(?m)^-- name: (\w+)`)
	sqlStringList    = regexp.MustCompile(`'([^']*)'`)
)

// sqlLiterals returns the string literals a statement compares with or
// assigns to table.column, qualified by the table or its alias, or bare.
func sqlLiterals(statement string, column sqlColumn) []string {
	if !regexp.MustCompile(`\b` + column.table + `\b`).MatchString(statement) {
		return nil
	}
	qualifiers := []string{column.table}
	for _, alias := range regexp.MustCompile(`\b`+column.table+`\s+(?:AS\s+)?(\w+)`).FindAllStringSubmatch(statement, -1) {
		qualifiers = append(qualifiers, alias[1])
	}
	reference := `(?:^|[^.\w])(?:(\w+)\.)?` + column.column + `\s*`
	var out []string
	for _, match := range regexp.MustCompile(reference+`(?:=|<>|!=)\s*'([^']*)'`).FindAllStringSubmatch(statement, -1) {
		if match[1] == "" || slices.Contains(qualifiers, match[1]) {
			out = append(out, match[2])
		}
	}
	for _, match := range regexp.MustCompile(`(?i)`+reference+`(?:NOT\s+)?IN\s*\(([^)]*)\)`).FindAllStringSubmatch(statement, -1) {
		if match[1] == "" || slices.Contains(qualifiers, match[1]) {
			for _, literal := range sqlStringList.FindAllStringSubmatch(match[2], -1) {
				out = append(out, literal[1])
			}
		}
	}
	return out
}

// Queries read and write the same columns; a literal outside the enum is a
// value the database rejects or a filter that can never match.
func TestEnumListsCoverSQLLiterals(t *testing.T) {
	files, err := filepath.Glob("../store/queries/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("no query files: %v", err)
	}
	seen := map[string]int{}
	for _, path := range files {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		names := sqlStatementName.FindAllStringSubmatch(string(source), -1)
		bodies := sqlStatementName.Split(string(source), -1)[1:]
		for i, body := range bodies {
			for _, vocab := range vocabularies() {
				for _, column := range vocab.columns {
					for _, value := range sqlLiterals(body, column) {
						seen[vocab.name]++
						if !slices.Contains(vocab.list, value) {
							t.Errorf("%s %s: %s.%s literal %q is not in the enum list %v",
								filepath.Base(path), names[i][1], column.table, column.column, value, vocab.list)
						}
					}
				}
			}
		}
	}
	for _, vocab := range vocabularies() {
		if len(vocab.columns) > 0 && !vocab.noSQLLiteral && seen[vocab.name] == 0 {
			t.Errorf("%s: no SQL literal found; the scan no longer matches the queries", vocab.name)
		}
	}
}

// Every constrained column's CHECK must admit exactly its enum list.
func TestEnumListsMatchDatabaseChecks(t *testing.T) {
	baseline, err := os.ReadFile("../migrate/sql/00001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	checks := map[string][]string{
		"recovery_case_artifacts_kind_check":         domain.RecoveryCaseArtifactKinds,
		"recovery_case_artifacts_actor_check":        domain.RecoveryCaseActorKinds,
		"recovery_case_transitions_actor_check":      domain.RecoveryCaseActorKinds,
		"recovery_case_transitions_from_state_check": domain.RecoveryCaseStates,
		"recovery_case_transitions_to_state_check":   domain.RecoveryCaseStates,
		"recovery_cases_state_check":                 domain.RecoveryCaseStates,
		"recovery_cases_action_check":                domain.RecoveryDetectorActions,
		"workflow_rollouts_status_check":             domain.WorkflowRolloutStatuses,
	}
	for name, list := range checks {
		check := regexp.MustCompile(`CONSTRAINT ` + name + ` CHECK \(\(\w+ = ANY \(ARRAY\[([^\]]*)\]\)\)\)`).FindSubmatch(baseline)
		if check == nil {
			t.Errorf("%s not found in the baseline", name)
			continue
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
