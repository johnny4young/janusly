//go:build integration

package e2e

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
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

// A loopback bind must stay unreachable from the host's other interfaces,
// while the readyz healthcheck still finds it.
func TestPublicListenerHonorsLoopbackBind(t *testing.T) {
	t.Setenv("JANUSLY_HTTP_HOST", "127.0.0.1")
	api := bootBinary(t)
	port := strings.TrimPrefix(api.base, "http://127.0.0.1:")

	probe := exec.Command(buildBinary(t), "readyz")
	probe.Env = append(os.Environ(), "JANUSLY_PORT="+port)
	if out, err := probe.CombinedOutput(); err != nil {
		t.Fatalf("readyz against a loopback bind must exit 0: %v\n%s", err, out)
	}
	assertLoopbackOnly(t, port)
}

// While development auth headers are accepted, the API defaults to loopback
// and refuses a wildcard bind that nobody acknowledged.
func TestDevAuthHeadersKeepThePublicListenerOnLoopback(t *testing.T) {
	t.Setenv("SUPABASE_URL", "")
	t.Setenv("JANUSLY_HTTP_HOST", "")
	api := bootBinary(t)
	assertLoopbackOnly(t, strings.TrimPrefix(api.base, "http://127.0.0.1:"))

	refused := exec.Command(buildBinary(t))
	refused.Env = append(os.Environ(), "JANUSLY_HTTP_HOST=0.0.0.0", fmt.Sprintf("JANUSLY_PORT=%d", freePort(t)))
	done := make(chan []byte, 1)
	go func() { out, _ := refused.CombinedOutput(); done <- out }()
	select {
	case out := <-done:
		if refused.ProcessState.Success() || !strings.Contains(string(out), "ALLOW_DEV_AUTH_HEADERS_ON_NETWORK=true") {
			t.Fatalf("a wildcard bind with development headers must refuse to boot:\n%s", out)
		}
	case <-time.After(15 * time.Second):
		_ = refused.Process.Kill()
		t.Fatal("a wildcard bind with development headers kept running")
	}
}

func assertLoopbackOnly(t *testing.T, port string) {
	t.Helper()
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if !ok || network.IP.IsLoopback() || network.IP.To4() == nil {
			continue
		}
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(network.IP.String(), port), time.Second)
		if err == nil {
			_ = conn.Close()
			t.Fatalf("loopback-bound API answered on %s", network.IP)
		}
		return
	}
	t.Skip("no non-loopback IPv4 interface to probe")
}
