package orgconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestEnvironmentReferenceMatchesCatalog(t *testing.T) {
	reference, err := os.ReadFile("../../docs/environment-reference.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, definition := range Definitions {
		encoded, err := json.Marshal(definition.Default)
		if err != nil {
			t.Fatal(err)
		}
		bound := func(value *float64) string {
			if value == nil {
				return "unbounded"
			}
			return strconv.FormatFloat(*value, 'f', -1, 64)
		}
		limits := "catalog validator"
		if len(definition.AllowedValues) > 0 {
			limits = strings.Join(definition.AllowedValues, ", ")
		} else if definition.Min != nil || definition.Max != nil {
			limits = bound(definition.Min) + ".." + bound(definition.Max)
		}
		for _, key := range definition.EnvKeys {
			row := fmt.Sprintf("| `%s` | Tenant | `%s` | %s | `%s` | %s |", key, definition.Key, definition.ValueType, encoded, limits)
			if !strings.Contains(string(reference), row) {
				t.Errorf("missing/stale catalog row: %s", row)
			}
		}
	}
}
