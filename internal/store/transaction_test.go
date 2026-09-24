package store

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

type savepointCommands struct {
	DBTX
	commands []string
	failOn   string
	failure  error
}

func (s *savepointCommands) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	s.commands = append(s.commands, sql)
	if sql == s.failOn {
		return pgconn.CommandTag{}, s.failure
	}
	return pgconn.NewCommandTag("OK"), nil
}

func TestTrySavepointControlFailures(t *testing.T) {
	const create = "SAVEPOINT janusly_optional_operation"
	const rollback = "ROLLBACK TO SAVEPOINT janusly_optional_operation"
	const release = "RELEASE SAVEPOINT janusly_optional_operation"
	failure := errors.New("control statement failed")
	operationFailure := errors.New("optional operation failed")
	for _, tc := range []struct {
		name, failOn       string
		operationError     error
		wantCommands       []string
		applied, wantError bool
	}{
		{"success", "", nil, []string{create, release}, true, false},
		{"recovered", "", operationFailure, []string{create, rollback, release}, false, false},
		{"create failed", create, nil, []string{create}, false, true},
		{"rollback failed", rollback, operationFailure, []string{create, rollback}, false, true},
		{"release failed", release, nil, []string{create, release}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &savepointCommands{failOn: tc.failOn, failure: failure}
			called := false
			applied, err := New(db).TrySavepoint(context.Background(), func(got DBTX) error {
				called = true
				if got != db {
					t.Fatal("lost transaction wrapper")
				}
				return tc.operationError
			})
			if applied != tc.applied || errors.Is(err, failure) != tc.wantError {
				t.Fatalf("applied=%v err=%v", applied, err)
			}
			if called != (tc.failOn != create) {
				t.Fatalf("callback called=%v", called)
			}
			if !reflect.DeepEqual(db.commands, tc.wantCommands) {
				t.Fatalf("commands=%v want=%v", db.commands, tc.wantCommands)
			}
			if tc.failOn == rollback && !errors.Is(err, operationFailure) {
				t.Fatal("lost operation error on rollback failure")
			}
		})
	}
}
