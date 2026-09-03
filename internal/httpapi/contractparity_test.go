// Manifest ↔ router parity for the versioned surface.
//
// internal/contract/manifest.go says "Adding a v1 route means adding one entry
// here", and until now that was an honour-system rule: manifest_test.go checks
// the manifest against ITSELF (no duplicates, every entry has a response
// shape) and the `make contract` drift guard regenerates openapi.json FROM the
// manifest. Neither one ever asked the router what it actually serves, so a
// route could ship with no declared contract and nothing would say a word.
// Twelve had.
//
// A missing entry is not cosmetic. contract/openapi.json is what a client
// generator reads, so an undeclared route is invisible to every consumer that
// derives from it — the frontend keeps hand-writing the shape it guesses, and
// the guess is what drifts.
//
// Zero baseline in both directions: an undeclared route fails, and so does a
// manifest entry for a route nobody mounts.

package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/contract"
)

// readPackageSources returns this package's non-test Go sources.
func readPackageSources(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	var sources []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Clean(name))
		if readErr != nil {
			t.Fatalf("read %s: %v", name, readErr)
		}
		sources = append(sources, string(raw))
	}
	return sources
}

// mountedPattern matches only literal patterns passed directly to the mux.
// Dynamic strings (for example a recovery route prefix concatenated with an
// action) are already represented by routeAuthz after mountAPIRoutes runs and
// must not be mistaken for a complete route.
var mountedPattern = regexp.MustCompile(`mux\.Handle(?:Func)?\(\s*"(GET|POST|PUT|PATCH|DELETE) (/v1/[^"]*)"`)

// mountedV1Routes asks the ROUTER, not a regex over handler files: the mux is
// built exactly as the serving path builds it, then walked for its patterns.
func mountedV1Routes(t *testing.T) map[string]bool {
	t.Helper()
	mux := http.NewServeMux()
	(&V1Server{}).mountAPIRoutes(mux)

	// http.ServeMux exposes no pattern listing, so the mounted set is the
	// UNION of two authoritative sources:
	//
	//   - routeAuthz, which route() and contractedRoute() populate. This is
	//     the only place a dynamically built pattern shows up: contractedRoute
	//     composes "/v1"+path at mount time, so a source scan cannot see it.
	//     Scanning source alone silently stopped covering twelve routes the
	//     moment they moved to the helper — a guard with a blind spot reads
	//     exactly like a guard that passes.
	//   - literal patterns in source, for the handful mounted straight through
	//     mux.HandleFunc without a gate (they live in authOnlyRoutes instead).
	routes := map[string]bool{}
	for pattern := range routeAuthz {
		if strings.HasPrefix(pattern, "GET /v1/") || strings.HasPrefix(pattern, "POST /v1/") ||
			strings.HasPrefix(pattern, "PUT /v1/") || strings.HasPrefix(pattern, "PATCH /v1/") ||
			strings.HasPrefix(pattern, "DELETE /v1/") {
			routes[pattern] = true
		}
	}
	for _, source := range readPackageSources(t) {
		for _, match := range mountedPattern.FindAllStringSubmatch(source, -1) {
			routes[match[1]+" "+match[2]] = true
		}
	}
	if len(routes) == 0 {
		t.Fatal("no /v1 routes found — the extractor is broken, not the router")
	}
	return routes
}

// notEnvelopedResponses are the two /v1 routes that deliberately do NOT write
// the v1 envelope, so a manifest entry would describe them wrongly: the
// manifest's Response field means "the DATA payload the envelope wraps".
// Keep this list at two — anything else belongs in the manifest.
var notEnvelopedResponses = map[string]string{
	"GET /v1/openapi.json": "serves the contract document itself, raw; " +
		"declaring it inside the contract it generates would be circular",
	"GET /v1/reports/run-explain": "a download: Content-Disposition attachment, " +
		"markdown or raw JSON depending on ?format, never the envelope",
}

func TestEveryV1RouteIsDeclaredInTheManifest(t *testing.T) {
	mounted := mountedV1Routes(t)
	for key := range notEnvelopedResponses {
		if !mounted[key] {
			t.Errorf("exemption %q names a route nobody mounts; delete it", key)
		}
		delete(mounted, key)
	}

	declared := map[string]bool{}
	for _, route := range contract.Routes {
		declared[route.Method+" "+route.Path] = true
	}

	var undeclared, stale []string
	for key := range mounted {
		if !declared[key] {
			undeclared = append(undeclared, key)
		}
	}
	for key := range declared {
		if !mounted[key] {
			stale = append(stale, key)
		}
	}

	if len(undeclared) > 0 {
		sort.Strings(undeclared)
		t.Errorf("%d mounted /v1 route(s) have no contract manifest entry.\n"+
			"contract/openapi.json is generated from that manifest, so these routes are\n"+
			"invisible to anything that derives a client from it. Add an entry in\n"+
			"internal/contract/manifest.go with the real request and response shapes.\n\n   %s",
			len(undeclared), strings.Join(undeclared, "\n   "))
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		t.Errorf("%d manifest entr(ies) describe a route nobody mounts.\n"+
			"A contract for a route that does not exist is worse than no contract:\n"+
			"a generated client will offer a call that 404s.\n\n   %s",
			len(stale), strings.Join(stale, "\n   "))
	}
}
