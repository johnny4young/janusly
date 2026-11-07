package engine

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Same-millisecond events of one run must keep their write order.
func TestEventIDsAscendInGenerationOrder(t *testing.T) {
	previous := newEventID()
	for range 10_000 {
		next := newEventID()
		if next <= previous {
			t.Fatalf("event id %s generated after %s sorts before it", next, previous)
		}
		previous = next
	}
}

// Every run_events insert outside the generated store must take its id from
// newEventID, directly or through a variable assigned from it.
func TestRunEventInsertsUseNewEventID(t *testing.T) {
	root := filepath.Join("..", "..")
	set := token.NewFileSet()
	sites := 0
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				if path == filepath.Join(root, "internal", "store") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(strings.ToUpper(string(source)), "INSERT INTO RUN_EVENTS") {
				t.Errorf("%s: raw run_events insert bypasses the store queries", path)
			}
			file, err := parser.ParseFile(set, path, source, 0)
			if err != nil {
				return err
			}
			sites += checkRunEventIDs(t, set, file, filepath.Dir(path) == filepath.Join(root, "internal", "engine"))
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if sites < 30 {
		t.Fatalf("found only %d run event inserts; the scan no longer sees them", sites)
	}
}

func checkRunEventIDs(t *testing.T, set *token.FileSet, file *ast.File, engine bool) int {
	t.Helper()
	fromNewEventID := map[string]bool{}
	ast.Inspect(file, func(node ast.Node) bool {
		if assign, ok := node.(*ast.AssignStmt); ok && len(assign.Lhs) == 1 && len(assign.Rhs) == 1 && isNewEventIDCall(assign.Rhs[0]) {
			if name, ok := assign.Lhs[0].(*ast.Ident); ok {
				fromNewEventID[name.Name] = true
			}
		}
		return true
	})
	valid := func(expr ast.Expr) bool {
		if isNewEventIDCall(expr) {
			return true
		}
		name, ok := expr.(*ast.Ident)
		return ok && fromNewEventID[name.Name]
	}
	sites := 0
	ast.Inspect(file, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.CompositeLit:
			selector, ok := value.Type.(*ast.SelectorExpr)
			if !ok || !strings.HasPrefix(selector.Sel.Name, "InsertRunEvent") || !strings.HasSuffix(selector.Sel.Name, "Params") {
				return true
			}
			// The buffer forwards ids that callers already checked through add.
			if engine && set.File(value.Pos()).Name() == filepath.Join("..", "..", "internal", "engine", "eventbuffer.go") {
				return true
			}
			sites++
			id := keyedValue(value, "ID")
			if id == nil || !valid(id) {
				t.Errorf("%s: %s id must come from newEventID()", set.Position(value.Pos()), selector.Sel.Name)
			}
		case *ast.CallExpr:
			selector, ok := value.Fun.(*ast.SelectorExpr)
			if !engine || !ok || selector.Sel.Name != "add" || len(value.Args) != 6 {
				return true
			}
			sites++
			if !valid(value.Args[0]) {
				t.Errorf("%s: buffered run event id must come from newEventID()", set.Position(value.Pos()))
			}
		}
		return true
	})
	return sites
}

func isNewEventIDCall(expr ast.Expr) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok || len(call.Args) != 0 {
		return false
	}
	name, ok := call.Fun.(*ast.Ident)
	return ok && name.Name == "newEventID"
}

func keyedValue(literal *ast.CompositeLit, key string) ast.Expr {
	for _, element := range literal.Elts {
		pair, ok := element.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if name, ok := pair.Key.(*ast.Ident); ok && name.Name == key {
			return pair.Value
		}
	}
	return nil
}
