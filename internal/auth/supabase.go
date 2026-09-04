// Supabase Auth API verification over plain HTTP — no SDK. The contract
// calls supabase.auth.getUser(token), which is GET {SUPABASE_URL}/auth/v1/user
// with the project key as apikey and the user token as Bearer; the runtime
// performs the same request directly.
package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/httpjson"
)

// Redirects are refused outright: Go strips Authorization on a cross-host hop
// but not the custom apikey header, so a redirect from a misconfigured or
// hostile SUPABASE_URL would leak the service-role key.
var supabaseHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

const supabaseUserResponseMaxBytes = 64 << 10

func verifySupabaseUser(ctx context.Context, baseURL, apiKey, token string) (string, string, bool) {
	if baseURL == "" || apiKey == "" || token == "" {
		return "", "", false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(baseURL, "/")+"/auth/v1/user", nil)
	if err != nil {
		return "", "", false
	}
	req.Header.Set("apikey", apiKey)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := supabaseHTTPClient.Do(req)
	if err != nil {
		return "", "", false
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", "", false
	}
	var payload struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	if err := httpjson.Decode(res.Body, supabaseUserResponseMaxBytes, &payload); err != nil || payload.ID == "" {
		return "", "", false
	}
	return payload.ID, strings.ToLower(payload.Email), true
}
