//go:build integration

package store

import (
	"context"
	"testing"
)

func TestTrySavepointNestedRecovery(t *testing.T) {
	ctx, pool, _, _ := newHarness(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE optional_writes (id integer) ON COMMIT DROP`); err != nil {
		t.Fatal(err)
	}
	q := New(tx)
	applied, err := q.TrySavepoint(ctx, func(db DBTX) error {
		if _, err := db.Exec(ctx, `INSERT INTO optional_writes VALUES (1)`); err != nil {
			return err
		}
		innerApplied, err := New(db).TrySavepoint(ctx, func(db DBTX) error {
			if _, err := db.Exec(ctx, `INSERT INTO optional_writes VALUES (2)`); err != nil {
				return err
			}
			_, err := db.Exec(ctx, `SELECT 1/0`)
			return err
		})
		if err != nil {
			return err
		}
		if innerApplied {
			t.Fatal("failed SQL applied")
		}
		_, err = db.Exec(ctx, `INSERT INTO optional_writes VALUES (3)`)
		return err
	})
	if err != nil || !applied {
		t.Fatalf("applied=%v err=%v", applied, err)
	}
	var ids []int
	if err := tx.QueryRow(ctx, `SELECT array_agg(id ORDER BY id) FROM optional_writes`).Scan(&ids); err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != 1 || ids[1] != 3 {
		t.Fatalf("nested rollback leaked writes: %v", ids)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestTrySavepointRequiresLiveTransaction(t *testing.T) {
	ctx, pool, q, _ := newHarness(t)
	called := false
	if _, err := q.TrySavepoint(ctx, func(DBTX) error { called = true; return nil }); err == nil || called {
		t.Fatal("nontransactional handle accepted")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := New(tx).TrySavepoint(canceled, func(DBTX) error { called = true; return nil }); err == nil || called {
		t.Fatal("canceled operation accepted")
	}
}
