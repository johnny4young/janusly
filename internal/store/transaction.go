package store

import (
	"context"
	"errors"
	"fmt"
)

// TrySavepoint isolates an optional operation on an existing transaction.
// A recovered operation failure returns (false, nil); savepoint failures must
// abort the caller. The callback must return every SQL error. It must not commit
// or roll back the transaction. Nested calls target the innermost savepoint.
// Using the original DBTX preserves transaction wrappers and never acquires a
// second connection. A pool is not a valid backing handle for this method.
func (q *Queries) TrySavepoint(ctx context.Context, operation func(DBTX) error) (bool, error) {
	const name = "janusly_optional_operation"
	if _, err := q.db.Exec(ctx, "SAVEPOINT "+name); err != nil {
		return false, fmt.Errorf("create optional savepoint: %w", err)
	}
	operationErr := operation(q.db)
	if operationErr != nil {
		if _, err := q.db.Exec(ctx, "ROLLBACK TO SAVEPOINT "+name); err != nil {
			return false, fmt.Errorf("rollback optional savepoint: %w", errors.Join(operationErr, err))
		}
	}
	if _, err := q.db.Exec(ctx, "RELEASE SAVEPOINT "+name); err != nil {
		return false, fmt.Errorf("release optional savepoint: %w", err)
	}
	return operationErr == nil, nil
}
