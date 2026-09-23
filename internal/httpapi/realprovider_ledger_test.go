//go:build realprovider

package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

// This is a qualification-only, append-only reservation ledger. A reservation
// is NEVER refunded automatically: a timeout, crash, or lost provider receipt
// may have incurred a charge. The independent .lock inode also serializes
// writers when the ledger file does not exist yet.
type realProviderLedger struct{ path string }

type realProviderReservation struct {
	Version        int    `json:"version"`
	CaseID         string `json:"caseId"`
	ReservedMicros int64  `json:"reservedMicroUsd"`
	ReservedAt     string `json:"reservedAt"`
}

type realProviderLedgerTotals struct {
	Calls          int
	ReservedMicros int64
}

const realProviderLedgerMaxBytes = 1 << 20

var errRealProviderLedgerLimit = errors.New("qualification lifetime reservation limit reached")

func microUSD(value float64) (int64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || value > 3 {
		return 0, errors.New("invalid qualification USD amount")
	}
	return int64(math.Ceil(value * 1_000_000)), nil
}

func (l realProviderLedger) reserve(caseID string, projectedUSD, maxUSD float64, maxCalls, maxCallsPerCase int) (realProviderLedgerTotals, error) {
	if !filepath.IsAbs(l.path) || caseID == "" || len(caseID) > 120 || bytes.IndexByte([]byte(caseID), '\n') >= 0 {
		return realProviderLedgerTotals{}, errors.New("qualification ledger path and case ID are required")
	}
	projection, err := microUSD(projectedUSD)
	if err != nil {
		return realProviderLedgerTotals{}, err
	}
	_, err = microUSD(maxUSD)
	if err != nil {
		return realProviderLedgerTotals{}, err
	}
	capMicros := int64(math.Floor(maxUSD * 1_000_000))
	if maxCalls < 1 || maxCallsPerCase < 1 {
		return realProviderLedgerTotals{}, errors.New("invalid qualification call caps")
	}
	if info, statErr := os.Lstat(filepath.Dir(l.path)); statErr != nil || !info.IsDir() {
		return realProviderLedgerTotals{}, errors.New("qualification ledger parent directory is missing")
	}
	resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(l.path))
	if err != nil {
		return realProviderLedgerTotals{}, errors.New("qualification ledger parent directory cannot be resolved")
	}
	for directory := resolvedParent; ; directory = filepath.Dir(directory) {
		if _, statErr := os.Lstat(filepath.Join(directory, ".git")); statErr == nil {
			return realProviderLedgerTotals{}, errors.New("qualification ledger must be outside every Git worktree")
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return realProviderLedgerTotals{}, errors.New("qualification ledger worktree boundary cannot be inspected")
		}
		if parent := filepath.Dir(directory); parent == directory {
			break
		}
	}
	for _, path := range []string{l.path, l.path + ".lock"} {
		if info, statErr := os.Lstat(path); statErr == nil && !info.Mode().IsRegular() {
			return realProviderLedgerTotals{}, errors.New("qualification ledger or lock is not a regular file")
		} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return realProviderLedgerTotals{}, errors.New("qualification ledger path cannot be inspected")
		}
	}
	lock, err := os.OpenFile(l.path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return realProviderLedgerTotals{}, fmt.Errorf("open qualification ledger lock: %w", err)
	}
	defer func() { _ = lock.Close() }()
	if info, err := lock.Stat(); err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return realProviderLedgerTotals{}, errors.New("qualification ledger lock is insecure")
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return realProviderLedgerTotals{}, fmt.Errorf("lock qualification ledger: %w", err)
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()

	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return realProviderLedgerTotals{}, fmt.Errorf("open qualification ledger: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > realProviderLedgerMaxBytes {
		return realProviderLedgerTotals{}, errors.New("qualification ledger is insecure or invalid")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return realProviderLedgerTotals{}, err
	}
	data, err := io.ReadAll(io.LimitReader(file, realProviderLedgerMaxBytes+1))
	if err != nil || len(data) > realProviderLedgerMaxBytes {
		return realProviderLedgerTotals{}, errors.New("qualification ledger cannot be read safely")
	}
	totals, caseCalls, err := parseRealProviderLedger(data, caseID)
	if err != nil {
		return realProviderLedgerTotals{}, err
	}
	if totals.Calls >= maxCalls || caseCalls >= maxCallsPerCase || totals.ReservedMicros > capMicros-projection {
		return totals, errRealProviderLedgerLimit
	}
	entry, err := json.Marshal(realProviderReservation{
		Version: 1, CaseID: caseID, ReservedMicros: projection,
		ReservedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return totals, err
	}
	entry = append(entry, '\n')
	if len(data)+len(entry) > realProviderLedgerMaxBytes {
		return totals, errors.New("qualification ledger is full")
	}
	if n, err := file.Write(entry); err != nil || n != len(entry) {
		return totals, errors.New("qualification ledger write failed; reservation state unknown")
	}
	if err := file.Sync(); err != nil {
		return totals, errors.New("qualification ledger sync failed; reservation state unknown")
	}
	// A newly created ledger needs its directory entry persisted too; otherwise
	// a power loss can discard the name after the file's contents were synced.
	directory, err := os.Open(filepath.Dir(l.path))
	if err != nil {
		return totals, errors.New("qualification ledger directory cannot be synced")
	}
	defer func() { _ = directory.Close() }()
	if err := directory.Sync(); err != nil {
		return totals, errors.New("qualification ledger directory sync failed; reservation state unknown")
	}
	totals.Calls++
	totals.ReservedMicros += projection
	return totals, nil
}

func parseRealProviderLedger(data []byte, caseID string) (realProviderLedgerTotals, int, error) {
	var totals realProviderLedgerTotals
	if len(data) == 0 {
		return totals, 0, nil
	}
	if data[len(data)-1] != '\n' {
		return totals, 0, errors.New("qualification ledger has an incomplete reservation")
	}
	caseCalls := 0
	for line := range bytes.SplitSeq(data[:len(data)-1], []byte{'\n'}) {
		var entry realProviderReservation
		if err := json.Unmarshal(line, &entry); err != nil || entry.Version != 1 || entry.CaseID == "" ||
			entry.ReservedMicros <= 0 || entry.ReservedMicros > 3_000_000 || entry.ReservedAt == "" {
			return realProviderLedgerTotals{}, 0, errors.New("qualification ledger has an invalid reservation")
		}
		if totals.ReservedMicros > 3_000_000-entry.ReservedMicros {
			return realProviderLedgerTotals{}, 0, errors.New("qualification ledger exceeds the absolute USD 3 ceiling")
		}
		totals.Calls++
		totals.ReservedMicros += entry.ReservedMicros
		if entry.CaseID == caseID {
			caseCalls++
		}
	}
	return totals, caseCalls, nil
}

func TestRealProviderLedgerKeepsUnknownReservationsAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	first := realProviderLedger{path: path}
	if totals, err := first.reserve("case-a", 0.2, 0.5, 3, 1); err != nil || totals.Calls != 1 {
		t.Fatalf("first pre-egress reserve: totals=%+v err=%v", totals, err)
	}
	// Simulate a provider response that never arrived: no settlement is written.
	// A new process must still count the attempted call and its projected cost.
	restarted := realProviderLedger{path: path}
	if _, err := restarted.reserve("case-a", 0.2, 0.5, 3, 1); err == nil {
		t.Fatal("restart must retain per-case call consumption")
	}
	if totals, err := restarted.reserve("case-b", 0.2, 0.5, 3, 1); err != nil || totals.Calls != 2 || totals.ReservedMicros != 400_000 {
		t.Fatalf("second lifetime reserve: totals=%+v err=%v", totals, err)
	}
	if _, err := restarted.reserve("case-c", 0.2, 0.5, 3, 1); err == nil {
		t.Fatal("lifetime USD cap must refuse a third call")
	}
	if _, err := restarted.reserve("case-c", 0.1, 0.5, 2, 1); err == nil {
		t.Fatal("lifetime call cap must refuse a third call")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("ledger permissions: info=%v err=%v", info, err)
	}
}

func TestRealProviderLedgerSerializesConcurrentProcesses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	const contenders = 8
	results := make(chan int, contenders)
	var group sync.WaitGroup
	for i := range contenders {
		group.Go(func() {
			cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestRealProviderLedgerChild$")
			cmd.Env = append(os.Environ(), "JANUSLY_LEDGER_CHILD_PATH="+path,
				fmt.Sprintf("JANUSLY_LEDGER_CHILD_CASE=case-%d", i))
			if output, err := cmd.CombinedOutput(); err != nil {
				var exit *exec.ExitError
				if errors.As(err, &exit) && exit.ExitCode() == 3 {
					results <- 3
					return
				}
				t.Errorf("ledger child failed: %v %s", err, output)
				results <- 4
				return
			}
			results <- 0
		})
	}
	group.Wait()
	close(results)
	allowed := 0
	for code := range results {
		if code == 0 {
			allowed++
		} else if code != 3 {
			t.Fatalf("unexpected ledger child exit code: %d", code)
		}
	}
	if allowed != 3 {
		t.Fatalf("concurrent USD admissions=%d, want 3", allowed)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	totals, _, err := parseRealProviderLedger(data, "none")
	if err != nil || totals.Calls != 3 || totals.ReservedMicros != 600_000 {
		t.Fatalf("persisted concurrent totals=%+v err=%v", totals, err)
	}
}

func TestRealProviderLedgerChild(t *testing.T) {
	path := os.Getenv("JANUSLY_LEDGER_CHILD_PATH")
	if path == "" {
		return
	}
	caseID := os.Getenv("JANUSLY_LEDGER_CHILD_CASE")
	_, err := (realProviderLedger{path: path}).reserve(caseID, 0.2, 0.6, 40, 2)
	if err == nil {
		os.Exit(0)
	}
	if errors.Is(err, errRealProviderLedgerLimit) {
		os.Exit(3)
	}
	fmt.Fprintln(os.Stderr, err)
	os.Exit(4)
}

func TestRealProviderLedgerFailsClosedOnCorruptionAndMissingPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.jsonl")
	if err := os.WriteFile(path, []byte(`{"version":1,"caseId":"old","reservedMicroUsd":200000`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (realProviderLedger{path: path}).reserve("new", 0.1, 3, 40, 2); err == nil {
		t.Fatal("incomplete previous reservation must fail closed")
	}
	if _, err := (realProviderLedger{}).reserve("new", 0.1, 3, 40, 2); err == nil {
		t.Fatal("missing shared ledger must fail closed")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (realProviderLedger{path: path}).reserve("new", 0.1, 3, 40, 2); err == nil {
		t.Fatal("world-readable ledger must fail closed")
	}
	alias := filepath.Join(filepath.Dir(path), "alias.jsonl")
	if err := os.Symlink(path, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := (realProviderLedger{path: alias}).reserve("new", 0.1, 3, 40, 2); err == nil {
		t.Fatal("symlinked ledger must fail closed")
	}
}

func TestRealProviderLedgerRejectsCheckoutLocalPath(t *testing.T) {
	checkout := filepath.Join(t.TempDir(), "checkout")
	inside := filepath.Join(checkout, "output")
	if err := os.MkdirAll(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	// Managed worktrees use a .git file rather than a .git directory.
	if err := os.WriteFile(filepath.Join(checkout, ".git"), []byte("gitdir: elsewhere\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(inside, alias); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(inside, "ledger.jsonl"), filepath.Join(alias, "ledger.jsonl")} {
		if _, err := (realProviderLedger{path: path}).reserve("case", 0.1, 3, 40, 2); err == nil {
			t.Errorf("checkout-local ledger must fail closed before reservation: %s", path)
		}
	}
}
