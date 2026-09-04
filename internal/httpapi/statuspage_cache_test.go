package httpapi

import (
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/store"
)

func TestStatusPageCacheServesWithinTTLAndDropsExpired(t *testing.T) {
	cache := &statusPageCache{}
	fresh := statusPageSnapshot{at: time.Now()}
	stale := statusPageSnapshot{at: time.Now().Add(-2 * statusPageCacheTTL)}
	cache.put("fresh", fresh)
	cache.put("stale", stale)

	if _, ok := cache.get("fresh"); !ok {
		t.Fatal("a fresh snapshot must be served from the cache")
	}
	if _, ok := cache.get("stale"); ok {
		t.Fatal("an expired snapshot must not be served")
	}
	// Writing another entry sweeps the expired one out of the map.
	cache.put("other", fresh)
	if _, present := cache.entries["stale"]; present {
		t.Fatal("expired entries must be dropped on write so the map stays bounded")
	}
}

func TestStatusPageCacheForgetsAWorkflowOnRotationOrRevocation(t *testing.T) {
	cache := &statusPageCache{}
	now := time.Now()
	cache.put("old-token", statusPageSnapshot{at: now, page: store.FindWorkflowStatusPageByTokenDigestRow{WorkflowID: "wf-a"}})
	cache.put("other", statusPageSnapshot{at: now, page: store.FindWorkflowStatusPageByTokenDigestRow{WorkflowID: "wf-b"}})

	cache.forget("wf-a")
	if _, ok := cache.get("old-token"); ok {
		t.Fatal("a rotated token must not be served from the cache")
	}
	if _, ok := cache.get("other"); !ok {
		t.Fatal("forgetting one workflow must not evict another")
	}
}
