// Command authoringcheck checks frozen synthetic authoring mechanics offline.
// It predicts rules and can copy fixture graphs, but cannot retrieve a live
// workflow, contact a provider, save a draft or execute a proposal. The explicit
// registry-fixture lane owns a fresh loopback PostgreSQL database only.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/johnny4young/janusly/internal/authoring"
)

type checkReport struct {
	Mechanics authoring.DecisionMechanicsReport `json:"mechanics"`
	Rules     authoring.RulesMechanicsReport    `json:"rules"`
	Replay    *authoring.ExperienceReplayReport `json:"replay,omitempty"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--registry-fixture" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := runRegistryFixture(ctx, os.Getenv("JANUSLY_DATABASE_URL"), os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) < 2 || len(os.Args) > 3 {
		fmt.Fprintln(os.Stderr, "usage: authoringcheck <mechanics-corpus.json> [replay-corpus.json] | --registry-fixture")
		os.Exit(2)
	}
	if err := runCheck(context.Background(), os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func readCorpus(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot open corpus")
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, limit+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, errors.New("cannot read corpus")
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("corpus exceeds limit")
	}
	return raw, nil
}

func runCheck(ctx context.Context, args []string, out io.Writer) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("invalid corpus arguments")
	}
	raw, err := readCorpus(args[0], 4*1024*1024)
	if err != nil {
		return err
	}
	var report checkReport
	report.Mechanics, err = authoring.CheckDecisionMechanicsCorpus(ctx, raw)
	if err != nil {
		return err
	}
	report.Rules, err = authoring.CheckRulesMechanicsCorpus(ctx, raw)
	if err != nil {
		return err
	}
	if len(args) == 2 {
		replayRaw, err := readCorpus(args[1], 8*1024*1024)
		if err != nil {
			return err
		}
		replay, err := authoring.ReplayExperienceCorpus(ctx, replayRaw)
		if err != nil {
			return err
		}
		report.Replay = &replay
	}
	if err := json.NewEncoder(out).Encode(report); err != nil {
		return err
	}
	if report.Rules.Correct != report.Rules.Cases || (report.Replay != nil && report.Replay.Correct != report.Replay.Cases) {
		return errors.New("offline case expectations did not match")
	}
	return ctx.Err()
}
