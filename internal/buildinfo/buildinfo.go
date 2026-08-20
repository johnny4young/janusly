// Package buildinfo exposes the immutable identity of the running Go binary.
// Release builds inject the exact Git commit and tree; the finished executable
// hashes itself at startup so the artifact digest never becomes self-referential.
package buildinfo

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

const SchemaVersion = 1

var (
	buildCommit string
	buildTree   string
	hex40       = regexp.MustCompile(`^[0-9a-f]{40}$`)
	hex64       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// zero40 is the build-arg placeholder of development images. It is a
	// syntactically valid object id that names no Git object, so it must
	// never satisfy provenance.
	zero40 = strings.Repeat("0", 40)
)

func isRealObjectID(value string) bool {
	return hex40.MatchString(value) && value != zero40
}

// Identity is safe for the internal operations listener. It contains no
// environment values, paths, hostnames, or credentials.
type Identity struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Commit         string `json:"commit"`
	Tree           string `json:"tree"`
	ArtifactSHA256 string `json:"artifactSha256"`
	Verified       bool   `json:"verified"`
}

// Current identifies the executable that owns the current process.
func Current() (Identity, error) {
	path, err := os.Executable()
	if err != nil {
		return Identity{}, fmt.Errorf("resolve running executable: %w", err)
	}
	return fromExecutable(path)
}

func fromExecutable(path string) (Identity, error) {
	file, err := os.Open(path)
	if err != nil {
		return Identity{}, fmt.Errorf("open running executable: %w", err)
	}
	defer func() { _ = file.Close() }()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return Identity{}, fmt.Errorf("hash running executable: %w", err)
	}
	identity := Identity{
		SchemaVersion:  SchemaVersion,
		Commit:         strings.TrimSpace(buildCommit),
		Tree:           strings.TrimSpace(buildTree),
		ArtifactSHA256: fmt.Sprintf("%x", hash.Sum(nil)),
	}
	identity.Verified = identity.fieldsValid()
	return identity, nil
}

func (identity Identity) fieldsValid() bool {
	return identity.SchemaVersion == SchemaVersion &&
		isRealObjectID(identity.Commit) &&
		isRealObjectID(identity.Tree) &&
		hex64.MatchString(identity.ArtifactSHA256)
}

// Validate rejects development or malformed binaries at production and gate
// boundaries. Verified is derived when the executable is hashed, never trusted
// as a substitute for checking every field.
func (identity Identity) Validate() error {
	var problems []error
	if identity.SchemaVersion != SchemaVersion {
		problems = append(problems, fmt.Errorf(
			"build provenance schema must be %d, got %d", SchemaVersion, identity.SchemaVersion))
	}
	if !hex40.MatchString(identity.Commit) {
		problems = append(problems, errors.New(
			"build provenance commit must be 40 lowercase hexadecimal characters"))
	} else if identity.Commit == zero40 {
		problems = append(problems, errors.New(
			"build provenance commit is the all-zero development placeholder"))
	}
	if !hex40.MatchString(identity.Tree) {
		problems = append(problems, errors.New(
			"build provenance tree must be 40 lowercase hexadecimal characters"))
	} else if identity.Tree == zero40 {
		problems = append(problems, errors.New(
			"build provenance tree is the all-zero development placeholder"))
	}
	if !hex64.MatchString(identity.ArtifactSHA256) {
		problems = append(problems, errors.New(
			"build provenance artifact SHA-256 must be 64 lowercase hexadecimal characters"))
	}
	if !identity.Verified {
		problems = append(problems, errors.New("build provenance was not verified from the running executable"))
	}
	return errors.Join(problems...)
}
