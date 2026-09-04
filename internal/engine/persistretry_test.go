package engine

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTransientPersistenceError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"lock timeout", &pgconn.PgError{Code: "55P03"}, true},
		{"serialization failure", &pgconn.PgError{Code: "40001"}, true},
		{"deadlock victim", &pgconn.PgError{Code: "40P01"}, true},
		{"connection failure", &pgconn.PgError{Code: "08006"}, true},
		{"wrapped lock timeout", errors.Join(errors.New("commit"), &pgconn.PgError{Code: "55P03"}), true},
		{"statement timeout", &pgconn.PgError{Code: "57014"}, false},
		{"unique violation", &pgconn.PgError{Code: "23505"}, false},
		{"plain error", errors.New("boom"), false},
		{"unexpected eof", io.ErrUnexpectedEOF, true},
	}
	for _, tc := range cases {
		if got := transientPersistenceError(tc.err); got != tc.want {
			t.Errorf("%s: transient=%v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestPersistOutcomeReplaysTransientFailuresOnly(t *testing.T) {
	previous := persistRetryBaseDelay
	persistRetryBaseDelay = time.Microsecond
	t.Cleanup(func() { persistRetryBaseDelay = previous })
	eng := &Engine{randFloat: func() float64 { return 0 }}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()

	calls := 0
	err := eng.persistOutcome(ctx, logger, "complete", ClaimedNode{}, func() error {
		calls++
		if calls < 3 {
			return &pgconn.PgError{Code: "55P03"}
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("transient failures must be replayed until success: calls=%d err=%v", calls, err)
	}

	calls = 0
	permanent := errors.New("node snapshot invalid")
	if err := eng.persistOutcome(ctx, logger, "complete", ClaimedNode{}, func() error {
		calls++
		return permanent
	}); !errors.Is(err, permanent) || calls != 1 {
		t.Fatalf("a permanent error must surface at once: calls=%d err=%v", calls, err)
	}

	calls = 0
	err = eng.persistOutcome(ctx, logger, "fail", ClaimedNode{}, func() error {
		calls++
		return &pgconn.PgError{Code: "40P01"}
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || calls != persistRetryAttempts {
		t.Fatalf("the budget must bound replays: calls=%d err=%v", calls, err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	calls = 0
	if err := eng.persistOutcome(cancelled, logger, "retry", ClaimedNode{}, func() error {
		calls++
		return &pgconn.PgError{Code: "55P03"}
	}); err == nil || calls != 1 {
		t.Fatalf("a cancelled context must not keep replaying: calls=%d err=%v", calls, err)
	}
}
