package config

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// This is a documentation coverage alarm, not environment-read inference.
// Constants may be reserved or unsupported; their classification is reviewed in
// the reference. Dynamic names require the separately documented caller audit.
var environmentLiteral = regexp.MustCompile(`^(JANUSLY_|ALLOW_|API_ALLOWED_|ANTHROPIC_|SUPABASE_|WORKOS_|OLLAMA_|AWS_|RESEND_|SENDGRID_|OTEL_|AI_)[A-Z0-9_]*[A-Z0-9]$`)
var classifiedEnvironmentRow = regexp.MustCompile("(?m)^\\| `([A-Z][A-Z0-9_]+)` \\| (Process|Tenant|Secret|Platform|Build|CLI|Harness|Unsupported) \\|")

func environmentNames(source []byte) ([]string, error) {
	file, err := parser.ParseFile(token.NewFileSet(), "inventory.go", source, 0)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(literal.Value)
		if err == nil && environmentLiteral.MatchString(value) {
			names[value] = true
		}
		return true
	})
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	slices.Sort(out)
	return out, nil
}

func missingEnvironmentNames(names []string, reference string) []string {
	classified := map[string]bool{}
	for _, match := range classifiedEnvironmentRow.FindAllStringSubmatch(reference, -1) {
		classified[match[1]] = true
	}
	var missing []string
	for _, name := range names {
		if !classified[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

func TestProductionEnvironmentLiteralsAreClassified(t *testing.T) {
	root := filepath.Join("..", "..")
	reference, err := os.ReadFile(filepath.Join(root, "docs", "environment-reference.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"cmd", "internal"} {
		err := filepath.WalkDir(filepath.Join(root, directory), func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			names, err := environmentNames(source)
			if err != nil {
				return err
			}
			for _, name := range missingEnvironmentNames(names, string(reference)) {
				t.Errorf("%s: classify %s in docs/environment-reference.md", path, name)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestEnvironmentInventoryRejectsUnclassifiedFixture(t *testing.T) {
	names, err := environmentNames([]byte(`package fixture
 // JANUSLY_COMMENT_ONLY is not evidence of a knob.
 const reserved = "JANUSLY_RESERVED_PROBE"
 func read() string { return lookup("JANUSLY_NEW_PROBE") }
 const prefix = "JANUSLY_"
 `))
	if err != nil {
		t.Fatal(err)
	}
	reference := "| `JANUSLY_RESERVED_PROBE` | Unsupported | fixture | owner |\nMentioning `JANUSLY_NEW_PROBE` without a category is insufficient."
	if missing := missingEnvironmentNames(names, reference); !slices.Equal(missing, []string{"JANUSLY_NEW_PROBE"}) {
		t.Fatalf("missing=%v", missing)
	}
}
