package mcpserver

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
)

func TestTokenInQueryFindsTokensOutsideNamedParameters(t *testing.T) {
	for query, want := range map[string]bool{
		"access_token=x":           true,
		"jly_agent_abc":            true,
		"h=Bearer%20jly_agent_abc": true,
		"a=1;b=jly_agent_abc":      true,
		"x=jly%5Fagent%5Fabc":      true,
		"cursor=abc&limit=10":      false,
	} {
		_, found := tokenInQuery(httptest.NewRequest("POST", "/mcp?"+query, nil))
		if found != want {
			t.Errorf("%q: found %v, want %v", query, found, want)
		}
	}
}

func TestForwardedPlainHTTPChecksEveryHop(t *testing.T) {
	for values, want := range map[string]bool{
		"https":       false,
		"http":        true,
		"HTTP":        true,
		"https, http": true,
		"https,https": false,
	} {
		r := httptest.NewRequest("POST", "/mcp", nil)
		r.Header.Set("X-Forwarded-Proto", values)
		if got := forwardedPlainHTTP(r); got != want {
			t.Errorf("%q: got %v, want %v", values, got, want)
		}
	}
	r := httptest.NewRequest("POST", "/mcp", nil)
	r.Header.Add("X-Forwarded-Proto", "https")
	r.Header.Add("X-Forwarded-Proto", "http")
	if !forwardedPlainHTTP(r) {
		t.Error("a second header carrying http was ignored")
	}
}

func TestRemoteMCPRefusesSubscriptionStreams(t *testing.T) {
	principal := &agentclient.Principal{ClientID: "c", OrgID: "o", Tools: map[string]bool{}}
	server := httptest.NewServer(newStreamableHandler(Deps{Transport: "http",
		ResolveActor: func(context.Context, mcp.Request) (*agentclient.Principal, error) { return principal, nil },
	}, nil))
	t.Cleanup(server.Close)
	body := `{"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{"_meta":{` +
		`"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},` +
		`"io.modelcontextprotocol/clientInfo":{"name":"x","version":"1"}},"notifications":{"toolsListChanged":true}}}`
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "subscriptions/listen")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	reply, err := io.ReadAll(res.Body)
	if err != nil || !strings.Contains(string(reply), "-32601") {
		t.Fatalf("listen stream was served: %q %v", reply, err)
	}
}
