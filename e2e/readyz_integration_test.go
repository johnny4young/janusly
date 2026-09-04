//go:build integration

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The container healthcheck is `janusly readyz`: the same executable probes
// the serving process, because the distroless image has no shell or curl.
func TestReadyzSubcommandProbesTheRunningServer(t *testing.T) {
	api := bootBinary(t)
	port := strings.TrimPrefix(api.base, "http://127.0.0.1:")

	probe := exec.Command(buildBinary(t), "readyz")
	probe.Env = append(os.Environ(), "JANUSLY_PORT="+port)
	if out, err := probe.CombinedOutput(); err != nil {
		t.Fatalf("readyz against a ready server must exit 0: %v\n%s", err, out)
	}

	dead := exec.Command(buildBinary(t), "readyz")
	dead.Env = append(os.Environ(), fmt.Sprintf("JANUSLY_PORT=%d", freePort(t)))
	if out, err := dead.CombinedOutput(); err == nil {
		t.Fatalf("readyz against nothing must exit non-zero\n%s", out)
	}
}
