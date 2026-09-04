package httpapi

import (
	"net/http"
	"sync"
	"testing"
)

// mountedRouteAuthz is the full per-server table (base literal plus every
// route() registration) for tests that enumerate gated patterns.
var mountedRouteAuthz = sync.OnceValue(func() map[string]routeGate {
	server := &V1Server{routeAuthz: newRouteAuthz()}
	server.mountAPIRoutes(http.NewServeMux())
	return server.routeAuthz
})

// Harnesses build many handlers per process, sometimes concurrently. The
// route authorization table used to be one package-level map that every
// mount wrote into — a data race under -race, and a runtime throw the day two
// servers were built at once. Each server now owns its copy.
func TestRouteTablesAreIndependentPerServer(t *testing.T) {
	var wg sync.WaitGroup
	servers := make([]*V1Server, 4)
	for i := range servers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			server := &V1Server{routeAuthz: newRouteAuthz()}
			server.mountAPIRoutes(http.NewServeMux())
			servers[i] = server
		}(i)
	}
	wg.Wait()
	for i, server := range servers {
		if len(server.routeAuthz) <= len(baseRouteAuthz) {
			t.Fatalf("server %d: mount must extend the base table (%d > %d)", i, len(server.routeAuthz), len(baseRouteAuthz))
		}
		if len(server.routeAuthz) != len(servers[0].routeAuthz) {
			t.Fatalf("server %d: tables diverge (%d vs %d)", i, len(server.routeAuthz), len(servers[0].routeAuthz))
		}
	}
	// The base literal stays exactly what the source declares.
	if _, leaked := baseRouteAuthz["GET /recovery/ledger"]; leaked {
		t.Fatal("route() must never write into the shared base table")
	}
}
