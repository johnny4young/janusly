// Command authoringcheck verifies a frozen, synthetic authoring decision corpus
// offline. It cannot retrieve a workflow, call a model or execute a proposal.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/johnny4young/janusly/internal/authoring"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: authoringcheck <mechanics-corpus.json>")
		os.Exit(2)
	}
	file, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, authoring.MaxMechanicsCorpusBytes+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		fmt.Fprintln(os.Stderr, "cannot read mechanics corpus")
		os.Exit(1)
	}
	report, err := authoring.CheckDecisionMechanicsCorpus(context.Background(), raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
