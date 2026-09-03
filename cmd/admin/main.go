// janusly-admin: the runbook curls as subcommands — every action
// goes through the EXISTING HTTP routes with a service token (or dev
// headers), never direct SQL, so the CLI can do exactly what the API
// authorizes and nothing more.
//
// Environment:
//
//	JANUSLY_ADMIN_API     target API (default http://127.0.0.1:3001)
//	JANUSLY_ADMIN_ORG     org id (default: default)
//	JANUSLY_ADMIN_TOKEN   service token (Authorization: Bearer), falling
//	                      back to JANUSLY_API_SERVICE_TOKEN; when both are
//	                      empty, dev headers are used with
//	                      JANUSLY_ADMIN_USER (default janusly-admin)
//
// Subcommands (every one accepts --json for scripting):
//
//	redrive --dead-letter <id>       exact-identity redrive of one row
//	redrive --signature <sig>        cluster redrive via /dlq/cluster-apply
//	schedules list                   schedule entries with next fires
//	schedules resync --workflow <id> re-sync from the latest version
//	credentials health               per-credential reachability
//	runs inspect --run <id>          run + node detail
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"

	"github.com/johnny4young/janusly/internal/runbookclient"
)

var (
	apiBase = envOr("JANUSLY_ADMIN_API", "http://127.0.0.1:3001")
	org     = envOr("JANUSLY_ADMIN_ORG", "default")
	token   = envOr("JANUSLY_ADMIN_TOKEN", os.Getenv("JANUSLY_API_SERVICE_TOKEN"))
	user    = envOr("JANUSLY_ADMIN_USER", "janusly-admin")
	client  *runbookclient.Client
)

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func call(method, path string, body any) (int, map[string]any) {
	status, decoded, err := client.DoJSON(context.Background(), method, path, body)
	if err != nil {
		fail("API call failed at %s: %v", apiBase, err)
	}
	return status, decoded
}

func withQuery(path string, values url.Values) string {
	return path + "?" + values.Encode()
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "janusly-admin: "+format+"\n", args...)
	os.Exit(1)
}

// emit prints the machine envelope under --json, or a terse human line.
func emit(asJSON bool, payload map[string]any, human func()) {
	if asJSON {
		encoded, _ := json.MarshalIndent(payload, "", "  ")
		fmt.Println(string(encoded))
		return
	}
	human()
}

func main() {
	var err error
	client, err = runbookclient.New(runbookclient.Config{
		BaseURL: apiBase, OrgID: org, UserID: user, BearerToken: token,
	})
	if err != nil {
		fail("configuration: %v", err)
	}
	if len(os.Args) < 2 {
		fail("usage: janusly-admin <redrive|schedules|credentials|runs> … (--json anywhere for scripting)")
	}
	switch os.Args[1] {
	case "redrive":
		cmdRedrive(os.Args[2:])
	case "schedules":
		cmdSchedules(os.Args[2:])
	case "credentials":
		cmdCredentials(os.Args[2:])
	case "runs":
		cmdRuns(os.Args[2:])
	default:
		fail("unknown subcommand %q", os.Args[1])
	}
}

func cmdRedrive(args []string) {
	flags := flag.NewFlagSet("redrive", flag.ExitOnError)
	deadLetter := flags.String("dead-letter", "", "dead letter id (exact-identity redrive)")
	signatureArg := flags.String("signature", "", "normalized failure signature (cluster redrive)")
	asJSON := flags.Bool("json", false, "machine output")
	_ = flags.Parse(args)
	switch {
	case *deadLetter != "":
		status, decoded := call("POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": *deadLetter})
		if status != 200 {
			fail("redrive failed: %d %+v", status, decoded)
		}
		emit(*asJSON, decoded, func() { fmt.Println("redriven:", *deadLetter) })
	case *signatureArg != "":
		status, decoded := call("POST", "/dlq/cluster-apply", map[string]any{"signature": *signatureArg, "action": "replay"})
		if status != 200 {
			fail("cluster redrive failed: %d %+v", status, decoded)
		}
		emit(*asJSON, decoded, func() { fmt.Printf("cluster replay applied for signature %s: %+v\n", *signatureArg, decoded) })
	default:
		fail("redrive needs --dead-letter <id> or --signature <sig>")
	}
}

func cmdSchedules(args []string) {
	if len(args) < 1 {
		fail("schedules needs list|resync")
	}
	flags := flag.NewFlagSet("schedules", flag.ExitOnError)
	workflow := flags.String("workflow", "", "workflow id")
	asJSON := flags.Bool("json", false, "machine output")
	_ = flags.Parse(args[1:])
	switch args[0] {
	case "list":
		if *workflow == "" {
			fail("schedules list needs --workflow <id> (entries are per-workflow)")
		}
		status, decoded := call("GET", "/workflows/"+url.PathEscape(*workflow)+"/schedule-history", nil)
		if status != 200 {
			fail("schedule history failed: %d %+v", status, decoded)
		}
		emit(*asJSON, decoded, func() {
			raw, _ := json.MarshalIndent(decoded, "", "  ")
			fmt.Println(string(raw))
		})
	case "resync":
		if *workflow == "" {
			fail("schedules resync needs --workflow <id>")
		}
		// Re-saving is the API's resync: rollback-to-latest re-syncs
		// schedules from the current version. The dedicated resync ride is
		// the restore route for tombstones; for live workflows the engine
		// resyncs on every save, so we touch the latest version.
		status, decoded := call("GET", withQuery("/v1/workflows/latest", url.Values{"workflowId": {*workflow}}), nil)
		if status != 200 {
			fail("workflow not found: %d %+v", status, decoded)
		}
		data, _ := decoded["data"].(map[string]any)
		sourceVersionID, _ := data["id"].(string)
		applied, result := call("POST", "/workflows/rollback", map[string]any{
			"workflowId": *workflow, "sourceVersionId": sourceVersionID,
		})
		if applied != 200 {
			fail("resync (rollback-to-current) failed: %d %+v", applied, result)
		}
		emit(*asJSON, result, func() {
			fmt.Printf("schedules resynced for %s (from version row %s)\n", *workflow, sourceVersionID)
		})
	default:
		fail("unknown schedules action %q", args[0])
	}
}

func cmdCredentials(args []string) {
	if len(args) < 1 || args[0] != "health" {
		fail("credentials needs health")
	}
	flags := flag.NewFlagSet("credentials", flag.ExitOnError)
	asJSON := flags.Bool("json", false, "machine output")
	_ = flags.Parse(args[1:])
	status, decoded := call("GET", "/credentials/health", nil)
	if status != 200 {
		fail("credentials health failed: %d %+v", status, decoded)
	}
	emit(*asJSON, decoded, func() {
		rows, _ := decoded["credentials"].([]any)
		if len(rows) == 0 {
			fmt.Println("no credentials configured")
			return
		}
		for _, raw := range rows {
			row, _ := raw.(map[string]any)
			fmt.Printf("%-24v %-12v %v\n", row["name"], row["kind"], row["status"])
		}
	})
}

func cmdRuns(args []string) {
	if len(args) < 1 || args[0] != "inspect" {
		fail("runs needs inspect")
	}
	flags := flag.NewFlagSet("runs", flag.ExitOnError)
	runID := flags.String("run", "", "run id")
	asJSON := flags.Bool("json", false, "machine output")
	_ = flags.Parse(args[1:])
	if *runID == "" {
		fail("runs inspect needs --run <id>")
	}
	status, decoded := call("GET", withQuery("/v1/run", url.Values{"runId": {*runID}}), nil)
	if status != 200 {
		fail("run inspect failed: %d %+v", status, decoded)
	}
	emit(*asJSON, decoded, func() {
		data, _ := decoded["data"].(map[string]any)
		run, _ := data["run"].(map[string]any)
		fmt.Printf("run %v — status %v, workflowVersion %v, created %v\n",
			run["id"], run["status"], run["workflowVersionId"], run["createdAt"])
		nodes, _ := data["nodes"].([]any)
		for _, raw := range nodes {
			node, _ := raw.(map[string]any)
			line := fmt.Sprintf("  %-16v %-10v attempts=%v", node["nodeId"], node["status"], node["attempts"])
			if node["errorJson"] != nil {
				errRaw, _ := json.Marshal(node["errorJson"])
				line += " error=" + truncate(string(errRaw), 100)
			}
			fmt.Println(line)
		}
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
