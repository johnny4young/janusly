package audit

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

type systemAuditRecorder struct {
	args []any
	err  error
}

func (r *systemAuditRecorder) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	r.args = args
	return pgconn.NewCommandTag("INSERT 0 1"), r.err
}

func TestSystemWriteInTxPreservesSystemShapeAndErrors(t *testing.T) {
	failure := errors.New("transaction failed")
	for _, actor := range []string{"system", ""} {
		t.Run("actor="+actor, func(t *testing.T) {
			recorder := &systemAuditRecorder{err: failure}
			metadata := map[string]any{"token": "sensitive-value"}
			err := (Writer{}).SystemWriteInTx(context.Background(), recorder, "org", actor, "recovery.item.created", Options{
				TargetType: "recovery-item", TargetID: "item", Metadata: metadata,
			})
			if !errors.Is(err, failure) {
				t.Fatalf("lost transaction error: %v", err)
			}
			if len(recorder.args) != 8 || recorder.args[1] != "org" || recorder.args[2] != nil {
				t.Fatalf("incorrect system identity: %v", recorder.args)
			}
			raw := recorder.args[6].([]byte)
			if strings.Contains(string(raw), "sensitive-value") {
				t.Fatal("metadata secret not redacted")
			}
			var stored map[string]any
			if err := json.Unmarshal(raw, &stored); err != nil {
				t.Fatal(err)
			}
			if actor != "" && stored["actor"] != actor {
				t.Fatalf("actor=%v", stored["actor"])
			}
			if actor == "" && stored["actor"] != nil {
				t.Fatal("empty actor must remain absent")
			}
			if stored["source"] != nil {
				t.Fatal("system writer introduced auth enrichment")
			}
			if _, ok := metadata["actor"]; ok {
				t.Fatal("mutated caller metadata")
			}
		})
	}
}
