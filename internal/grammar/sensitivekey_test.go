package grammar

import "testing"

func TestIsSensitiveKey(t *testing.T) {
	for _, key := range []string{
		"secret", "password", "token", "token_value", "tokenLimitSecret", "apiKey", "api_key", "Authorization",
		"cookie", "x-api-key", "clientSecret", "private_key",
		"apiToken", "accessToken", "access_token", "refresh_token", "id_token", "X-Auth-Token", "Set-Cookie",
		"proxy-authorization", "credentials", "passwd", "api_secret", "apiSecret",
	} {
		if !IsSensitiveKey(key) {
			t.Errorf("%q must be masked", key)
		}
	}
	for _, key := range []string{
		"tokens", "inputTokens", "outputTokens", "cachedInputTokens", "tokenizer", "maxTokens", "credential",
		"credentialId", "credentialRef", "idempotencyKey", "accessLevel", "identity", "cookies_enabled", "secrets_count",
		"passwordless", "orderId", "items",
	} {
		if IsSensitiveKey(key) {
			t.Errorf("%q must stay readable", key)
		}
	}
}
