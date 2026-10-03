package main

import "testing"

func TestRegistryFixtureOnlyAcceptsLiteralLoopbackPostgres(t *testing.T) {
	for _, dsn := range []string{"", "file:///private/tmp/db", "postgres://test@remote.example/db", "postgres://test@127.0.0.1/db?host=remote.example", "postgres://test@localhost/db", "postgres://test@127.0.0.1/db?dbname=real", "postgres://test@127.0.0.1/db?service=other", "postgres://test@127.0.0.1/db?sslmode=disable&sslmode=require", "postgres://test@127.0.0.1,remote.example/db"} {
		if _, err := fixtureAdminConfig(dsn); err == nil {
			t.Fatal("non-loopback fixture connection accepted")
		}
	}
	for _, dsn := range []string{"postgres://test@127.0.0.1:15473/db?sslmode=disable", "postgres://test@[::1]:15473/db"} {
		cfg, err := fixtureAdminConfig(dsn)
		if err != nil || cfg.ConnConfig.Database != "postgres" || cfg.MaxConns != 2 {
			t.Fatalf("loopback admin config: %v", err)
		}
	}
}
