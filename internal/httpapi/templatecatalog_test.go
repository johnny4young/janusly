package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// Every catalog template must parse and validate with zero fail-level
// issues: the gallery imports these verbatim, so a broken entry becomes a
// broken first-run experience. This also pins the i18n decoration every
// entry needs for the EN/ES gallery.
func TestTemplateCatalogWorkflowsValidate(t *testing.T) {
	for _, template := range templateCatalog {
		id, _ := template["id"].(string)
		if id == "" {
			t.Fatal("template without id")
		}
		for _, field := range []string{"nameCode", "descriptionCode", "categoryCode"} {
			if value, _ := template[field].(string); value == "" {
				t.Errorf("%s: missing %s", id, field)
			}
		}
		raw, err := json.Marshal(template["workflow"])
		if err != nil {
			t.Fatalf("%s: marshal workflow: %v", id, err)
		}
		wf, issues := domain.Parse(raw)
		if wf == nil {
			t.Fatalf("%s: workflow does not parse: %+v", id, issues)
		}
		result := domain.Validate(wf, grammar.DomainValidator)
		if !result.Valid {
			t.Errorf("%s: workflow invalid: %+v", id, result.Issues)
		}
	}
}
