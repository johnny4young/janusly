package executors

import (
	"slices"
	"testing"

	"github.com/johnny4young/janusly/internal/tools"
)

func TestCatalogRequiredNamesMatchRequiredFields(t *testing.T) {
	for _, entry := range SharedToolRegistry().CatalogEntries() {
		fields := map[string]tools.Field{}
		for _, field := range entry.InputFields {
			fields[field.Name] = field
		}
		for _, name := range entry.Required {
			if field, exists := fields[name]; exists && !field.Required {
				t.Errorf("%s: %s is required but its field is optional", entry.Name, name)
			}
		}
		for _, field := range entry.InputFields {
			if field.Required && !slices.Contains(entry.Required, field.Name) {
				t.Errorf("%s: field %s is required but missing from Required", entry.Name, field.Name)
			}
		}
	}
}
