package agentclient

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"github.com/johnny4young/janusly/internal/auth"
)

// TokenPrefix marks agent tokens so secret scanners and the general request
// resolver recognise them without looking anything up.
const TokenPrefix = auth.AgentTokenPrefix

const tokenSecretBytes = 32

var tokenEncodedLen = len(TokenPrefix) + base64.RawURLEncoding.EncodedLen(tokenSecretBytes)

// NewToken returns a fresh token, the digest to store and the last four
// characters to show. The plaintext is never persisted.
func NewToken() (token string, digest []byte, last4 string, err error) {
	secret := make([]byte, tokenSecretBytes)
	if _, err := rand.Read(secret); err != nil {
		return "", nil, "", err
	}
	token = TokenPrefix + base64.RawURLEncoding.EncodeToString(secret)
	return token, Digest(token), token[len(token)-4:], nil
}

// Digest is the lookup key for a token. A 256-bit random secret needs no
// slow hash; the digest only keeps the plaintext out of the database.
func Digest(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// LooksLikeToken reports the agent token shape, including the prefix alone,
// so callers can refuse it before any other credential check.
func LooksLikeToken(value string) bool {
	return strings.HasPrefix(value, TokenPrefix)
}

func wellFormed(token string) bool {
	if len(token) != tokenEncodedLen || !LooksLikeToken(token) {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(token[len(TokenPrefix):])
	return err == nil
}
