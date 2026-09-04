package engine

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Outcome persistence (complete, fail, retry, waiting) is a CAS-guarded
// transaction, so replaying it after a transient database error is safe —
// and far cheaper than the alternative, a node left `running` until the
// stalled-node reaper fails it fifteen minutes later. The budget is
// deliberately short: it rides out a cancelled lock wait or a checkpoint
// stall, not an outage (the reaper still owns those).
const (
	persistRetryAttempts = 6
	persistRetryMaxDelay = 4 * time.Second
)

// persistRetryBaseDelay doubles per retry up to persistRetryMaxDelay; a
// variable so tests can shrink the schedule without changing its shape.
var persistRetryBaseDelay = 250 * time.Millisecond

// transientPersistenceError reports whether an outcome transaction that
// failed with err may succeed when replayed: lock-wait cancellations,
// serialization failures, deadlock victims and lost connections. A
// statement timeout is excluded — the statement itself is the problem, and
// replaying it would only burn another full timeout.
func transientPersistenceError(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "55P03", "40001", "40P01":
			return true
		}
		return len(pgErr.Code) >= 2 && pgErr.Code[:2] == "08"
	}
	if pgconn.SafeToRetry(err) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

// persistOutcome runs commit until it succeeds, fails permanently, or the
// retry budget is spent, returning the last error. Every replay is logged
// and counted: a healthy database never needs one, so a stream of them is
// an operator signal in its own right.
func (e *Engine) persistOutcome(ctx context.Context, logger *slog.Logger, op string, claim ClaimedNode, commit func() error) error {
	delay := persistRetryBaseDelay
	for attempt := 1; ; attempt++ {
		err := commit()
		if err == nil || attempt >= persistRetryAttempts || ctx.Err() != nil || !transientPersistenceError(err) {
			return err
		}
		metricPersistRetries.WithLabelValues(op).Inc()
		logger.Warn("outcome persistence retried after a transient database error",
			"op", op, "runId", claim.RunID, "nodeId", claim.NodeID, "attempt", attempt, "error", err)
		jittered := delay + time.Duration(e.randFloat()*float64(delay)/2)
		select {
		case <-time.After(jittered):
		case <-ctx.Done():
			return err
		}
		delay = min(delay*2, persistRetryMaxDelay)
	}
}
