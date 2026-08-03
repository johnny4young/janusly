// Encrypted credential secret store — the pilot's port of the
// reference's credentialSecretStore.ts. New tenant secrets are
// envelope-encrypted in PostgreSQL (fresh 32-byte data key per value,
// AES-256-GCM twice: value under the data key, data key under the root
// key) while legacy environment-variable references stay readable during
// migration.
//
// Invariants (verbatim from the reference):
//   - The root key comes from ONE process-level secret and is never
//     persisted (JANUSLY_CREDENTIAL_MASTER_KEY inline base64/hex, or
//     _FILE); a boot probe fails fast on a malformed key.
//   - Every encrypted value uses a fresh data key and independent GCM
//     nonces; AAD binds ciphertext AND wrapped key to
//     (org, credential, version).
//   - Resolution is org-scoped and revoked rows fail CLOSED (nil); a
//     forged/damaged managed ref never falls through to the environment
//     provider.
//   - No error, log line, or return value ever carries plaintext,
//     ciphertext, key material, or secret refs — warnings carry stable
//     identifiers only, deduped and bounded per process.
package secretstore

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	secretRefPrefix = "janusly-secret://"
	rootKeyBytes    = 32
	dataKeyBytes    = 32
	nonceBytes      = 12
	maxSecretBytes  = 64 * 1024
	keyVersion      = 1
)

var managedSecretID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Sentinel errors (message-stable; never carry secret material).
var (
	ErrRootKeyInvalid = errors.New("credential_secret_root_key_invalid")
	ErrRootKeyMissing = errors.New("credential_secret_root_key_missing")
	ErrValueInvalid   = errors.New("credential_secret_value_invalid")
)

var (
	rootKeyMu     sync.Mutex
	cachedRootKey []byte

	// First warning per (row id, reason) per process: silent nils made a
	// split root-key misconfiguration (API vs worker) undiagnosable.
	warnedMu  sync.Mutex
	warned    = map[string]bool{}
	warnedMax = 1000
)

// CredentialSecretRef builds the opaque reference stored on
// credentials.secret_ref.
func CredentialSecretRef(id string) string { return secretRefPrefix + id }

// ParseCredentialSecretRef returns the encrypted-row id, or "" for a
// legacy environment reference.
func ParseCredentialSecretRef(secretRef string) string {
	if !strings.HasPrefix(secretRef, secretRefPrefix) {
		return ""
	}
	id := strings.TrimPrefix(secretRef, secretRefPrefix)
	if managedSecretID.MatchString(strings.ToLower(id)) {
		return id
	}
	return ""
}

// IsManagedCredentialSecretRef reports whether the reference belongs to
// the PostgreSQL-backed provider.
func IsManagedCredentialSecretRef(secretRef string) bool {
	return ParseCredentialSecretRef(secretRef) != ""
}

func decodeRootKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil && len(decoded) == rootKeyBytes {
		return decoded, nil
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(trimmed, "=")); err == nil && len(decoded) == rootKeyBytes {
		return decoded, nil
	}
	if matched, _ := regexp.MatchString(`^[0-9a-fA-F]{64}$`, trimmed); matched {
		return hex.DecodeString(trimmed)
	}
	return nil, ErrRootKeyInvalid
}

func loadRootKey() ([]byte, error) {
	rootKeyMu.Lock()
	defer rootKeyMu.Unlock()
	if cachedRootKey != nil {
		return cachedRootKey, nil
	}
	if inline := strings.TrimSpace(os.Getenv("JANUSLY_CREDENTIAL_MASTER_KEY")); inline != "" {
		key, err := decodeRootKey(inline)
		if err != nil {
			return nil, err
		}
		cachedRootKey = key
		return key, nil
	}
	if file := strings.TrimSpace(os.Getenv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE")); file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, ErrRootKeyInvalid
		}
		key, err := decodeRootKey(string(raw))
		if err != nil {
			return nil, err
		}
		cachedRootKey = key
		return key, nil
	}
	return nil, ErrRootKeyMissing
}

// AssertCredentialRootKeyUsable is the boot-time probe: a malformed
// inline key or unreadable key file fails fast at deploy time instead of
// surfacing as the first credential write's 500. An unset key stays
// legal (legacy-env-only deployments) and reports configured=false.
func AssertCredentialRootKeyUsable() (bool, error) {
	inline := strings.TrimSpace(os.Getenv("JANUSLY_CREDENTIAL_MASTER_KEY"))
	file := strings.TrimSpace(os.Getenv("JANUSLY_CREDENTIAL_MASTER_KEY_FILE"))
	if inline == "" && file == "" {
		return false, nil
	}
	if _, err := loadRootKey(); err != nil {
		return true, err
	}
	return true, nil
}

func aad(kind, orgID, credentialID string, version int32) []byte {
	return []byte("janusly:credential:" + kind + ":v1:" + orgID + ":" + credentialID + ":" + itoa(version))
}

func itoa(value int32) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for v := value; v > 0; v /= 10 {
		digits = string(rune('0'+v%10)) + digits
	}
	return digits
}

func sealAesGcm(plaintext, key, associatedData []byte) (ciphertext, nonce []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return gcm.Seal(nil, nonce, plaintext, associatedData), nonce, nil
}

func openAesGcm(ciphertext, key, nonce, associatedData []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, associatedData)
}

// splitSeal separates Go's combined ciphertext||tag into the reference's
// two stored columns (Node stores them apart; the wire schema is shared).
func splitSeal(sealed []byte) (ciphertext, tag []byte) {
	boundary := len(sealed) - 16
	return sealed[:boundary], sealed[boundary:]
}

func warnResolutionFailure(reason, orgID, secretVersionID string) {
	warnedMu.Lock()
	defer warnedMu.Unlock()
	if len(warned) >= warnedMax {
		warned = map[string]bool{}
	}
	key := secretVersionID + ":" + reason
	if warned[key] {
		return
	}
	warned[key] = true
	slog.Warn("[credential-secret-store] managed secret failed closed",
		"reason", reason, "orgId", orgID, "secretVersionId", secretVersionID)
}

// CreateCredentialSecretVersion inserts one encrypted version and
// returns its opaque reference. Runs on the given queries handle so
// credential creation + secret write can share one transaction.
func CreateCredentialSecretVersion(ctx context.Context, q *store.Queries, input struct {
	ID           string
	OrgID        string
	CredentialID string
	SecretValue  string
	CreatedBy    string
}) (id string, version int32, secretRef string, err error) {
	plaintext := []byte(input.SecretValue)
	if len(plaintext) == 0 || len(plaintext) > maxSecretBytes {
		return "", 0, "", ErrValueInvalid
	}
	next, err := q.NextCredentialSecretVersion(ctx, store.NextCredentialSecretVersionParams{
		OrgID: input.OrgID, CredentialID: input.CredentialID,
	})
	if err != nil {
		return "", 0, "", err
	}
	version = next
	id = input.ID
	if id == "" {
		id = uuid.NewString()
	}
	dataKey := make([]byte, dataKeyBytes)
	if _, err := rand.Read(dataKey); err != nil {
		return "", 0, "", err
	}
	defer zero(dataKey)
	sealedData, dataNonce, err := sealAesGcm(plaintext, dataKey, aad("data", input.OrgID, input.CredentialID, version))
	if err != nil {
		return "", 0, "", err
	}
	rootKey, err := loadRootKey()
	if err != nil {
		return "", 0, "", err
	}
	sealedKey, wrapNonce, err := sealAesGcm(dataKey, rootKey, aad("wrap", input.OrgID, input.CredentialID, version))
	if err != nil {
		return "", 0, "", err
	}
	ciphertext, dataTag := splitSeal(sealedData)
	wrappedKey, wrapTag := splitSeal(sealedKey)
	b64 := base64.StdEncoding.EncodeToString
	if err := q.InsertCredentialSecretVersion(ctx, store.InsertCredentialSecretVersionParams{
		ID: id, OrgID: input.OrgID, CredentialID: input.CredentialID, Version: version,
		Ciphertext: b64(ciphertext), DataNonce: b64(dataNonce), DataTag: b64(dataTag),
		WrappedKey: b64(wrappedKey), WrapNonce: b64(wrapNonce), WrapTag: b64(wrapTag),
		KeyVersion: keyVersion,
		CreatedBy:  pgtype.Text{String: input.CreatedBy, Valid: input.CreatedBy != ""},
	}); err != nil {
		return "", 0, "", err
	}
	return id, version, CredentialSecretRef(id), nil
}

// RevokeCredentialSecretRef revokes one managed reference; legacy
// environment refs are a no-op.
func RevokeCredentialSecretRef(ctx context.Context, q *store.Queries, orgID, secretRef string) error {
	id := ParseCredentialSecretRef(secretRef)
	if id == "" {
		return nil
	}
	return q.RevokeCredentialSecretVersion(ctx, store.RevokeCredentialSecretVersionParams{
		ID: id, OrgID: orgID,
	})
}

// ResolveCredentialSecretRef resolves a reference. Managed refs decrypt
// from an org-scoped, non-revoked row; other refs keep the legacy
// environment behavior. Any decrypt/config error fails closed as "".
func ResolveCredentialSecretRef(ctx context.Context, q *store.Queries, orgID, secretRef string) string {
	id := ParseCredentialSecretRef(secretRef)
	if id == "" {
		// A damaged or forged managed reference must never fall through to
		// the legacy environment provider.
		if strings.HasPrefix(secretRef, secretRefPrefix) {
			return ""
		}
		// The legacy environment provider is restricted: see envpolicy.go.
		// Enforced HERE and not only at the write path, because the
		// credentials table is shared with the compatibility runtime and
		// may already hold a row that names a reserved variable.
		if !EnvRefAllowed(secretRef) {
			slog.Error("[secret-store] refused a credential reference to a reserved environment variable",
				"orgId", orgID, "secretRef", secretRef)
			return ""
		}
		value := os.Getenv(secretRef)
		if strings.TrimSpace(value) == "" {
			return ""
		}
		return value
	}
	row, err := q.GetCredentialSecretVersion(ctx, store.GetCredentialSecretVersionParams{
		ID: id, OrgID: orgID,
	})
	if err != nil {
		// Missing row = legitimate nil (revoked, deleted, foreign org).
		return ""
	}
	if row.KeyVersion != keyVersion {
		warnResolutionFailure("unsupported_key_version", orgID, id)
		return ""
	}
	rootKey, err := loadRootKey()
	if err != nil {
		warnResolutionFailure("root_key_unavailable", orgID, id)
		return ""
	}
	b64 := func(value string) []byte {
		decoded, _ := base64.StdEncoding.DecodeString(value)
		return decoded
	}
	dataKey, err := openAesGcm(
		append(b64(row.WrappedKey), b64(row.WrapTag)...), rootKey, b64(row.WrapNonce),
		aad("wrap", row.OrgID, row.CredentialID, row.Version))
	if err != nil {
		warnResolutionFailure("decrypt_failed", orgID, id)
		return ""
	}
	defer zero(dataKey)
	plaintext, err := openAesGcm(
		append(b64(row.Ciphertext), b64(row.DataTag)...), dataKey, b64(row.DataNonce),
		aad("data", row.OrgID, row.CredentialID, row.Version))
	if err != nil {
		warnResolutionFailure("decrypt_failed", orgID, id)
		return ""
	}
	return string(plaintext)
}

// ResolveCredentialSecret resolves by tenant, kind, and name without
// exposing the reference — THE org-aware resolver every integration tool
// goes through.
func ResolveCredentialSecret(ctx context.Context, q *store.Queries, orgID, kind, name string) string {
	credential, err := q.GetCredentialByName(ctx, store.GetCredentialByNameParams{
		OrgID: orgID, Kind: kind, Name: name,
	})
	if err != nil {
		return ""
	}
	return ResolveCredentialSecretRef(ctx, q, orgID, credential.SecretRef)
}

// HasCredentialSecretRef is the health/readiness helper — never returns
// the value.
func HasCredentialSecretRef(ctx context.Context, q *store.Queries, orgID, secretRef string) bool {
	return ResolveCredentialSecretRef(ctx, q, orgID, secretRef) != ""
}

func zero(buffer []byte) {
	for i := range buffer {
		buffer[i] = 0
	}
}

// ResetForTests clears the root-key cache and the warn-once dedupe.
func ResetForTests() {
	rootKeyMu.Lock()
	zero(cachedRootKey)
	cachedRootKey = nil
	rootKeyMu.Unlock()
	warnedMu.Lock()
	warned = map[string]bool{}
	warnedMu.Unlock()
}
