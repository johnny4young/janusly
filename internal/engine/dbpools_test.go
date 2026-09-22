package engine

import (
	"testing"

	"github.com/johnny4young/janusly/internal/tools"
)

func TestEngineSharesExplicitDBPoolOwner(t *testing.T) {
	pools, err := tools.NewDBPools(1)
	if err != nil {
		t.Fatal(err)
	}
	defer pools.Close()
	first, second := New(nil, WithDBPools(pools)), New(nil, WithDBPools(pools))
	if first.buildIntegrationDeps("a", "r", "n").DBPools != pools || second.buildIntegrationDeps("b", "r", "n").DBPools != pools {
		t.Fatal("engines must share the runtime budget")
	}
	if New(nil).buildIntegrationDeps("a", "r", "n").DBPools != nil {
		t.Fatal("unconfigured engine created an implicit pool owner")
	}
}
