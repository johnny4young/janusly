package executors

import "sync"

// SharedToolRegistry is the process-wide catalog. The registry is immutable
// after construction and was being rebuilt per request in eight call sites;
// one lazily built instance serves validation, readiness, authoring, and the
// catalog routes alike.
var SharedToolRegistry = sync.OnceValue(NewToolRegistry)
