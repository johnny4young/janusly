//go:build integration

package httpapi

import (
	"io"
	"log/slog"
)

func quietTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
