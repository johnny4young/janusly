// Command artifact builds the current committed Janusly source into one
// provenance-bearing executable and a deterministic JSON manifest.
package main

import (
	"archive/tar"
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
	webDist := flags.String("web-dist", "web/dist", "built Vite directory to embed")
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

	webSource := *webDist
	if !filepath.IsAbs(webSource) {
		webSource = filepath.Join(root, webSource)
	}
	if info, err := os.Stat(filepath.Join(webSource, "index.html")); err != nil || info.IsDir() {
		return fmt.Errorf("web bundle is missing %s; build /web before creating the artifact", filepath.Join(webSource, "index.html"))
	}
	staging, err := os.MkdirTemp("", "janusly-artifact-source-*")
	if err != nil {
		return fmt.Errorf("create source staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := extractCommittedTree(root, staging); err != nil {
		return err
	}
	embedDestination := filepath.Join(staging, "internal", "webdist", "dist")
	if err := os.RemoveAll(embedDestination); err != nil {
		return fmt.Errorf("clear staged web bundle: %w", err)
	}
	if err := copyDirectory(webSource, embedDestination); err != nil {
		return fmt.Errorf("stage web bundle: %w", err)
	}

	ldflags := strings.Join([]string{
		"-s", "-w",
		"-X", "github.com/johnny4young/janusly/internal/buildinfo.buildCommit=" + commit,
		"-X", "github.com/johnny4young/janusly/internal/buildinfo.buildTree=" + tree,
	}, " ")
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags, "-o", temporaryPath, "./cmd/api")
	build.Dir = staging
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

func extractCommittedTree(root, destination string) error {
	command := exec.Command("git", "-C", root, "archive", "--format=tar", "HEAD")
	archive, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open git archive: %w", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return fmt.Errorf("start git archive: %w", err)
	}
	finished := false
	defer func() {
		if finished {
			return
		}
		_ = archive.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
	}()
	reader := tar.NewReader(archive)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read git archive: %w", err)
		}
		clean := filepath.Clean(filepath.FromSlash(header.Name))
		if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return fmt.Errorf("git archive contains unsafe path %q", header.Name)
		}
		path := filepath.Join(destination, clean)
		switch header.Typeflag {
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			// Git emits a global PAX header with repository metadata before
			// ordinary entries. archive/tar exposes it as a header but applies
			// per-file PAX records itself; neither represents a filesystem path.
			continue
		case tar.TypeDir:
			if err := os.MkdirAll(path, os.FileMode(header.Mode)&0o777); err != nil {
				return fmt.Errorf("create staged directory %s: %w", clean, err)
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return fmt.Errorf("create staged parent %s: %w", clean, err)
			}
			file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode)&0o777)
			if err != nil {
				return fmt.Errorf("create staged file %s: %w", clean, err)
			}
			_, copyErr := io.Copy(file, reader)
			closeErr := file.Close()
			if copyErr != nil {
				return fmt.Errorf("extract staged file %s: %w", clean, copyErr)
			}
			if closeErr != nil {
				return fmt.Errorf("close staged file %s: %w", clean, closeErr)
			}
		case tar.TypeSymlink:
			link := filepath.Clean(filepath.FromSlash(header.Linkname))
			if filepath.IsAbs(link) || link == ".." || strings.HasPrefix(link, ".."+string(filepath.Separator)) {
				return fmt.Errorf("git archive contains unsafe symlink %q", header.Name)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return fmt.Errorf("create staged symlink parent %s: %w", clean, err)
			}
			if err := os.Symlink(link, path); err != nil {
				return fmt.Errorf("create staged symlink %s: %w", clean, err)
			}
		default:
			return fmt.Errorf("git archive contains unsupported entry %q", header.Name)
		}
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("close git archive: %w", err)
	}
	if err := command.Wait(); err != nil {
		return fmt.Errorf("git archive HEAD: %w", err)
	}
	finished = true
	return nil
}

func copyDirectory(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("web bundle contains non-regular file %s", relative)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		inputCloseErr := input.Close()
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if inputCloseErr != nil {
			return inputCloseErr
		}
		return closeErr
	})
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
