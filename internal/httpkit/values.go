package httpkit

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// TextOrNull projects a nullable text column as its string or JSON null.
func TextOrNull(t pgtype.Text) any {
	if !t.Valid {
		return nil
	}
	return t.String
}

// TimeOrNull projects an optional instant in the wire's millisecond UTC form.
func TimeOrNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// NormalizedRaw turns an absent JSON column into the literal null so the
// wire never carries an empty token.
func NormalizedRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}

// IsUniqueViolation reports a PostgreSQL unique-constraint failure.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
