package orgconfig

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/johnny4young/janusly/internal/httpcontract"
)

// ValidateHTTPEnvironment checks process fallback settings before startup.
// Resolution remains tenant-scoped; this does not capture or freeze tenant rows.
// Messages contain only catalog keys/ranges, never operator-supplied values.
func ValidateHTTPEnvironment(getenv func(string) string) []string {
	var problems []string
	for i := range Definitions {
		def := &Definitions[i]
		if def.Category != "http" {
			continue
		}
		for _, key := range def.EnvKeys {
			raw := getenv(key)
			if strings.TrimSpace(raw) == "" {
				continue
			}
			if _, ok := parseEnv(def, raw); !ok {
				problems = append(problems, fmt.Sprintf("%s must be an integer in [%s, %s]", key, trimFloat(*def.Min), trimFloat(*def.Max)))
			}
		}
	}
	return problems
}

// ResolveHTTPBounds shares the catalog's validation, defaults and tenant →
// environment → default precedence. Rows belong to the caller's claim snapshot.
func ResolveHTTPBounds(rows map[string]json.RawMessage, lookupEnv func(string) (string, bool)) httpcontract.Bounds {
	number := func(key string) float64 {
		value, _ := ResolveValue(key, rows, lookupEnv)
		return value.(float64) // the closed HTTP catalog contains only numeric defaults
	}
	return httpcontract.Bounds{
		TimeoutMs:          number("http.timeoutMs"),
		MaxResponseBytes:   int(number("http.maxResponseBytes")),
		MaxRedirects:       int(number("http.maxRedirects")),
		StreamPreviewBytes: int(number("http.streamPreviewBytes")),
	}
}
