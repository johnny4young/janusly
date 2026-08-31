// Web ↔ route parity.
//
// Extracts every path `web/src` calls through api(), contractApi(), or the
// download client and asks the REAL router whether it resolves. Not a regex compared against another
// regex: the mux itself answers, so pattern precedence, method matching and
// wildcard segments are all exercised as they are in production.
//
// This guard existed in the Node implementation
// (`apps/api/src/routes-contract.test.ts`) and was not carried across the Go
// port. Without it, a web call to a route nobody registered falls through to
// the SPA catch-all and comes back as index.html with a 200 — the api()
// client parses that as an empty object, and the surface renders a
// fabricated empty state instead of an error. Four MCP panel routes, the
// workflow SLO form, the recovery-case resolve action and the item comment
// box all shipped that way.
//
// Scope: literal and template-literal api()/download paths plus every declared
// contractApi operation. A fully dynamic api(someVariable) cannot be resolved
// statically and is skipped; contractApi remains resolvable because its first
// argument is the generated operation key even if its concrete path is held in
// a variable.

package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// webSrcDir is the frontend source root, relative to this package.
const webSrcDir = "../../web/src"

// apiContractFile declares which GET paths the client rewrites to /v1.
const apiContractFile = "../../web/src/lib/api-contract.ts"

// viteConfigFile owns the development proxy namespace. Production mounts API
// routes before webdist, but Vite otherwise answers an unproxied API path with
// index.html and a misleading 200.
const viteConfigFile = "../../web/vite.config.ts"

// allowedUnresolvable lists call sites whose path genuinely cannot be
// resolved to one route at compile time, with the reason. Keep it short: an
// entry here is a hole in the guard.
var allowedUnresolvable = map[string]string{
	// RecoveryItemDrawer posts /recovery/items/{id}/{action} where action is
	// chosen at runtime (acknowledge / resolve / escalate / …). The generic
	// two-wildcard route serves them all; a static reader cannot know which.
	"POST /recovery/items/x/x": "action segment is chosen at runtime",
}

var (
	// api('/path', { method: 'POST' }) and downloadFromApi('/path')
	apiCallPattern = regexp.MustCompile(`\b(?:api|downloadFromApi)\(\s*([` + "`" + `'"])(/[^` + "`" + `'"]*)`)
	// contractApi('POST /path/{id}', concretePath, body)
	contractAPICallPattern = regexp.MustCompile(`\bcontractApi\(\s*['"](GET|POST|PUT|PATCH|DELETE)\s+(/[^'"]*)['"]`)
	// method: 'POST' appearing shortly after the path
	methodPattern = regexp.MustCompile(`method:\s*['"` + "`" + `](GET|POST|PUT|PATCH|DELETE)`)
	// `${...}` template segments and their surrounding path segment
	templateSegment = regexp.MustCompile(`\$\{[^}]*\}`)
	// OpenAPI-style path params in contractApi operation keys.
	routeParamSegment = regexp.MustCompile(`\{[^}/]+\}`)
)

type webCall struct {
	method string
	path   string
	file   string
	line   int
}

// v1ReadPaths mirrors the client's own rewrite table. It is READ from the
// TypeScript source rather than duplicated here: a copy would drift, and a
// drifted copy would make this test pass while the browser 404s.
func v1ReadPaths(t *testing.T) map[string]bool {
	t.Helper()
	raw, err := os.ReadFile(apiContractFile)
	if err != nil {
		t.Fatalf("read %s: %v", apiContractFile, err)
	}
	body := string(raw)
	start := strings.Index(body, "V1_READ_PATHS = {")
	if start < 0 {
		t.Fatal("V1_READ_PATHS not found — the client's /v1 rewrite table moved; " +
			"this test cannot tell which GETs are versioned and would report false passes")
	}
	end := strings.Index(body[start:], "\n}")
	if end < 0 {
		t.Fatal("V1_READ_PATHS block is not terminated")
	}
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`"(/[^"]*)"`).FindAllStringSubmatch(body[start:start+end], -1) {
		out[m[1]] = true
	}
	if len(out) == 0 {
		t.Fatal("V1_READ_PATHS parsed as empty")
	}
	return out
}

// collectWebCalls walks the frontend source and returns every statically
// resolvable API call.
func collectWebCalls(t *testing.T) []webCall {
	t.Helper()
	var calls []webCall
	err := filepath.WalkDir(webSrcDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".ts") && !strings.HasSuffix(name, ".tsx") {
			return nil
		}
		if strings.Contains(name, ".test.") || strings.Contains(name, ".browser.test.") {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		source := string(raw)
		for _, match := range apiCallPattern.FindAllStringSubmatchIndex(source, -1) {
			rawPath := source[match[4]:match[5]]
			// Look just past the path for an inline method; default GET.
			tail := source[match[1]:min(match[1]+300, len(source))]
			method := "GET"
			if m := methodPattern.FindStringSubmatch(tail); m != nil {
				method = m[1]
			}
			calls = append(calls, webCall{
				method: method,
				path:   rawPath,
				file:   path,
				line:   1 + strings.Count(source[:match[0]], "\n"),
			})
		}
		for _, match := range contractAPICallPattern.FindAllStringSubmatchIndex(source, -1) {
			calls = append(calls, webCall{
				method: source[match[2]:match[3]],
				path:   source[match[4]:match[5]],
				file:   path,
				line:   1 + strings.Count(source[:match[0]], "\n"),
			})
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", webSrcDir, err)
	}
	if len(calls) == 0 {
		t.Fatal("no api() calls found — the extractor is broken, not the frontend")
	}
	return calls
}

// wirePath applies the two transformations the client applies before the
// request leaves the browser: template segments become a concrete segment,
// and versioned GET reads gain their /v1 prefix.
func wirePath(call webCall, versioned map[string]bool) string {
	path := call.path
	if index := strings.Index(path, "?"); index >= 0 {
		path = path[:index]
	}
	// A `${...}` inside a segment stands for a real value; give the router
	// something concrete so a wildcard segment can match it.
	path = templateSegment.ReplaceAllString(path, "x")
	path = routeParamSegment.ReplaceAllString(path, "x")
	if call.method == "GET" && versioned[path] {
		return "/v1" + path
	}
	return path
}

// TestEveryWebPathResolvesToARegisteredRoute is the parity guard.
func TestEveryWebPathResolvesToARegisteredRoute(t *testing.T) {
	mux := http.NewServeMux()
	// A zero-value server is enough: mounting registers closures and never
	// touches the pool. The SPA catch-all is deliberately absent, so an
	// unregistered path resolves to nothing instead of to the HTML shell.
	(&V1Server{}).mountAPIRoutes(mux)

	versioned := v1ReadPaths(t)
	seen := map[string]bool{}
	var missing []string

	for _, call := range collectWebCalls(t) {
		path := wirePath(call, versioned)
		key := call.method + " " + path
		if seen[key] {
			continue
		}
		seen[key] = true
		if _, allowed := allowedUnresolvable[key]; allowed {
			continue
		}
		request := httptest.NewRequest(call.method, path, nil)
		_, pattern := mux.Handler(request)
		if pattern == "" {
			missing = append(missing, key+"\n      called from "+call.file+":"+itoa(call.line))
		}
	}

	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("%d path(s) the web calls resolve to no registered route.\n"+
			"In the serving path these fall through to the SPA catch-all and answer\n"+
			"index.html with a 200, so the caller sees an empty object rather than an\n"+
			"error. Register the route, fix the call, or add an allowlist entry with a\n"+
			"reason.\n\n   %s", len(missing), strings.Join(missing, "\n   "))
	}
}

// TestEveryWebPathTraversesViteDevProxy closes the development-only half of
// route parity. A backend route can be perfectly registered and still be
// unreachable from `make dev` when its top-level namespace is missing from
// Vite's proxy matcher; Vite then returns the SPA HTML shell as status 200.
func TestEveryWebPathTraversesViteDevProxy(t *testing.T) {
	raw, err := os.ReadFile(viteConfigFile)
	if err != nil {
		t.Fatalf("read %s: %v", viteConfigFile, err)
	}
	match := regexp.MustCompile(`const apiRoutePattern = '\^/\(\?:([^)]*)\)`).FindStringSubmatch(string(raw))
	if len(match) != 2 {
		t.Fatal("apiRoutePattern not found in Vite config — cannot verify development route parity")
	}
	prefixes := map[string]bool{}
	for _, prefix := range strings.Split(match[1], "|") {
		if prefix == "" || strings.ContainsAny(prefix, `\\?*+[]{}()`) {
			t.Fatalf("Vite API prefix %q is not a literal top-level path segment", prefix)
		}
		prefixes[prefix] = true
	}

	versioned := v1ReadPaths(t)
	seen := map[string]bool{}
	var missing []string
	for _, call := range collectWebCalls(t) {
		path := strings.TrimPrefix(wirePath(call, versioned), "/")
		prefix, _, _ := strings.Cut(path, "/")
		key := call.method + " " + prefix
		if seen[key] {
			continue
		}
		seen[key] = true
		if !prefixes[prefix] {
			missing = append(missing, call.method+" /"+prefix+"/…\n      called from "+call.file+":"+itoa(call.line))
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("%d web API namespace(s) bypass the Vite development proxy.\n"+
			"In make dev these requests receive index.html with status 200 instead of\n"+
			"reaching Go. Add the literal namespace to apiRoutePattern.\n\n   %s",
			len(missing), strings.Join(missing, "\n   "))
	}
}

// TestRouteParityAllowlistStaysHonest keeps the escape hatch from rotting
// into a place where unresolvable calls are parked and forgotten.
func TestRouteParityAllowlistStaysHonest(t *testing.T) {
	for key, reason := range allowedUnresolvable {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("allowlist entry %q carries no reason", key)
		}
	}
	if len(allowedUnresolvable) > 5 {
		t.Errorf("the allowlist has grown to %d entries; it is meant to hold the "+
			"handful of genuinely dynamic call sites, not to absorb drift",
			len(allowedUnresolvable))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
