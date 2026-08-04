// Command artifact builds the current committed Janusly source into one
// provenance-bearing executable and a deterministic JSON manifest.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const manifestSchemaVersion = 1

type manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	File          string `json:"file"`
	Commit        string `json:"commit"`
	Tree          string `json:"tree"`
	Platform      string `json:"platform"`
	Toolchain     string `json:"toolchain"`
	SizeBytes     int64  `json:"sizeBytes"`
	SHA256        string `json:"sha256"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "artifact:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("artifact", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	outputDir := flags.String("output-dir", "artifacts", "directory for janusly and manifest.json")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}

	root, err := gitValue("rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	if dirty, err := gitValue("status", "--porcelain", "--untracked-files=all"); err != nil {
		return err
	} else if dirty != "" {
		return errors.New("working tree is not clean; commit or remove changes before building an artifact")
	}
	commit, err := gitValue("rev-parse", "HEAD")
	if err != nil {
		return err
	}
	tree, err := gitValue("rev-parse", "HEAD^{tree}")
	if err != nil {
		return err
	}

	destination := *outputDir
	if !filepath.IsAbs(destination) {
		destination = filepath.Join(root, destination)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		return fmt.Errorf("create artifact directory: %w", err)
	}

	temporary, err := os.CreateTemp(destination, ".janusly-*")
	if err != nil {
		return fmt.Errorf("create temporary artifact: %w", err)
	}
	temporaryPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary artifact: %w", err)
	}
	defer func() { _ = os.Remove(temporaryPath) }()

	ldflags := strings.Join([]string{
		"-s", "-w",
		"-X", "github.com/johnny4young/janusly/internal/buildinfo.buildCommit=" + commit,
		"-X", "github.com/johnny4young/janusly/internal/buildinfo.buildTree=" + tree,
	}, " ")
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags, "-o", temporaryPath, "./cmd/api")
	build.Dir = root
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	build.Stdout = stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("build janusly: %w", err)
	}
	if err := os.Chmod(temporaryPath, 0o755); err != nil {
		return fmt.Errorf("mark artifact executable: %w", err)
	}

	size, digest, err := inspectFile(temporaryPath)
	if err != nil {
		return err
	}
	binaryPath := filepath.Join(destination, "janusly")
	if err := replaceFile(temporaryPath, binaryPath); err != nil {
		return fmt.Errorf("publish artifact: %w", err)
	}

	metadata := manifest{
		SchemaVersion: manifestSchemaVersion,
		File:          "janusly",
		Commit:        commit,
		Tree:          tree,
		Platform:      runtime.GOOS + "/" + runtime.GOARCH,
		Toolchain:     runtime.Version(),
		SizeBytes:     size,
		SHA256:        digest,
	}
	encoded, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	encoded = append(encoded, '\n')
	manifestPath := filepath.Join(destination, "manifest.json")
	if err := writeAtomic(manifestPath, encoded, 0o644); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "%s\n%s\n", binaryPath, manifestPath)
	return nil
}

func gitValue(args ...string) (string, error) {
	command := exec.Command("git", args...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func inspectFile(path string) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", fmt.Errorf("open artifact: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return 0, "", fmt.Errorf("stat artifact: %w", err)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return 0, "", fmt.Errorf("hash artifact: %w", err)
	}
	return info.Size(), hex.EncodeToString(hash.Sum(nil)), nil
}

func replaceFile(source, destination string) error {
	if err := os.Remove(destination); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(source, destination)
}

func writeAtomic(path string, body []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".manifest-*")
	if err != nil {
		return fmt.Errorf("create temporary manifest: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write manifest: %w", err)
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("chmod manifest: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close manifest: %w", err)
	}
	if err := replaceFile(temporaryPath, path); err != nil {
		return fmt.Errorf("publish manifest: %w", err)
	}
	return nil
}
