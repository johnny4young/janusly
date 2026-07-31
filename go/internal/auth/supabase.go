// Supabase Auth API verification over plain HTTP — no SDK. The reference
// calls supabase.auth.getUser(token), which is GET {SUPABASE_URL}/auth/v1/user
// with the project key as apikey and the user token as Bearer; the pilot
// performs the same request directly.
package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

var supabaseHTTPClient = &http.Client{Timeout: 10 * time.Second}

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
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil || payload.ID == "" {
		return "", "", false
	}
	return payload.ID, strings.ToLower(payload.Email), true
}
