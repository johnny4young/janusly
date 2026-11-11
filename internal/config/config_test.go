package config

import (
	"strings"
	"testing"
	"time"
)

func env(pairs map[string]string) func(string) string {
	return func(name string) string { return pairs[name] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 3001 || cfg.InternalPort != 9464 {
		t.Fatalf("unexpected ports: %+v", cfg)
	}
	if cfg.InternalHost != "127.0.0.1" {
		t.Fatalf("internal listener must default to loopback: %+v", cfg)
	}
	if cfg.WorkerConcurrency != 8 || cfg.PollInterval != 250*time.Millisecond {
		t.Fatalf("unexpected worker defaults: %+v", cfg)
	}
	if cfg.FeedbackMemoryWorkers != 4 || cfg.FeedbackMemoryQueueCapacity != 256 ||
		cfg.FeedbackMemoryTaskTimeout != 15*time.Second {
		t.Fatalf("unexpected feedback memory defaults: %+v", cfg)
	}
	if cfg.Production {
		t.Fatal("development defaults must not enable the production boot posture")
	}
	if cfg.DatabaseURL != "postgres://janusly:janusly-local@127.0.0.1:15473/janusly" {
		t.Fatalf("unexpected database default: %s", cfg.DatabaseURL)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"JANUSLY_DATABASE_URL":                   "postgres://operator:secret@db.example:6432/custom",
		"JANUSLY_PORT":                           "4700",
		"JANUSLY_INTERNAL_HOST":                  "0.0.0.0",
		"JANUSLY_WORKER_CONCURRENCY":             "2",
		"JANUSLY_POLL_MS":                        "500",
		"JANUSLY_FEEDBACK_MEMORY_WORKERS":        "6",
		"JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY": "512",
		"JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS":     "20000",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://operator:secret@db.example:6432/custom" {
		t.Fatal("explicit database URL must override the local default")
	}
	if cfg.Port != 4700 || cfg.InternalHost != "0.0.0.0" || cfg.WorkerConcurrency != 2 || cfg.PollInterval != 500*time.Millisecond {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
	if cfg.FeedbackMemoryWorkers != 6 || cfg.FeedbackMemoryQueueCapacity != 512 ||
		cfg.FeedbackMemoryTaskTimeout != 20*time.Second {
		t.Fatalf("feedback memory overrides not applied: %+v", cfg)
	}
}

func TestLoadRejectsOutOfRangeWithRangeInMessage(t *testing.T) {
	cases := []struct {
		name  string
		key   string
		value string
		want  string
	}{
		{"port too high", "JANUSLY_PORT", "70000", "[1, 65535]"},
		{"concurrency zero", "JANUSLY_WORKER_CONCURRENCY", "0", "[1, 64]"},
		{"poll below floor", "JANUSLY_POLL_MS", "10", "[50, 5000]"},
		{"not a number", "JANUSLY_HTTP_TIMEOUT_MS", "soon", "[1, 600000]"},
		{"feedback workers too high", "JANUSLY_FEEDBACK_MEMORY_WORKERS", "33", "[1, 32]"},
		{"feedback queue zero", "JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY", "0", "[1, 4096]"},
		{"feedback timeout too high", "JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS", "300001", "[1000, 300000]"},
		{"invalid internal host", "JANUSLY_INTERNAL_HOST", "metrics.example.com", "127.0.0.1, 0.0.0.0, ::1, or ::"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(env(map[string]string{tc.key: tc.value}))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.key) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("message must name the variable and its range, got: %v", err)
			}
		})
	}
}

func TestHTTPHostDefaultsToEveryInterfaceAndAcceptsOnlyBindLiterals(t *testing.T) {
	withIdentity := map[string]string{"SUPABASE_URL": "https://auth.example.test"}
	cfg, err := Load(env(withIdentity))
	if err != nil || cfg.HTTPHost != "" {
		t.Fatalf("default public bind must stay every interface: %q %v", cfg.HTTPHost, err)
	}
	for _, host := range []string{"127.0.0.1", "0.0.0.0", "::1", "::"} {
		if cfg, err := Load(env(map[string]string{"JANUSLY_HTTP_HOST": host, "SUPABASE_URL": "https://auth.example.test"})); err != nil || cfg.HTTPHost != host {
			t.Fatalf("JANUSLY_HTTP_HOST=%s rejected: %v", host, err)
		}
	}
	for _, host := range []string{"localhost", "10.0.0.5", "127.0.0.1:3001"} {
		if _, err := Load(env(map[string]string{"JANUSLY_HTTP_HOST": host})); err == nil {
			t.Fatalf("JANUSLY_HTTP_HOST=%q must be rejected", host)
		}
	}
}

// IPv6 loopback and wildcard are first-class: on hosts whose private
// network is IPv6-only, the IPv4 literals leave metrics unreachable.
func TestInternalHostAcceptsIPv6Binds(t *testing.T) {
	for _, host := range []string{"::1", "::"} {
		cfg, err := Load(env(map[string]string{"JANUSLY_INTERNAL_HOST": host}))
		if err != nil {
			t.Fatalf("load with JANUSLY_INTERNAL_HOST=%s: %v", host, err)
		}
		if cfg.InternalHost != host {
			t.Fatalf("internal host %q not preserved: %+v", host, cfg)
		}
	}
}

func TestProductionEnvironmentIsExplicit(t *testing.T) {
	cfg, err := Load(env(map[string]string{"JANUSLY_ENV": "production"}))
	if err != nil {
		t.Fatalf("load production: %v", err)
	}
	if !cfg.Production {
		t.Fatal("production environment must enable the production boot posture")
	}
}

func TestProductionRejectsLocalSimulatorGates(t *testing.T) {
	for _, name := range []string{"JANUSLY_LOCAL_STACK", "JANUSLY_LOCAL_INTEGRATION_SIMULATOR"} {
		t.Run(name, func(t *testing.T) {
			_, err := Load(env(map[string]string{
				"JANUSLY_ENV": "production",
				name:          "true",
			}))
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("production must reject %s: %v", name, err)
			}
		})
	}
}

func TestLoadAggregatesEveryProblem(t *testing.T) {
	_, err := Load(env(map[string]string{
		"JANUSLY_PORT":    "0",
		"JANUSLY_POLL_MS": "1",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "JANUSLY_PORT") || !strings.Contains(err.Error(), "JANUSLY_POLL_MS") {
		t.Fatalf("expected both violations reported, got: %v", err)
	}
}

func TestLoadRejectsEqualPorts(t *testing.T) {
	_, err := Load(env(map[string]string{
		"JANUSLY_PORT":          "3001",
		"JANUSLY_INTERNAL_PORT": "3001",
	}))
	if err == nil || !strings.Contains(err.Error(), "must differ") {
		t.Fatalf("expected the equal-port violation, got: %v", err)
	}
}

func TestPoolSizesDefaultAndDerive(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// API pool defaults to 10; the worker pool derives from concurrency so
	// every executor slot can hold a transaction plus claim + listener room.
	if cfg.APIPoolSize != 10 || cfg.WorkerPoolSize != cfg.WorkerConcurrency+2 {
		t.Fatalf("pool defaults wrong: api=%d worker=%d", cfg.APIPoolSize, cfg.WorkerPoolSize)
	}
	explicit, err := Load(env(map[string]string{
		"JANUSLY_WORKER_CONCURRENCY": "32",
		"JANUSLY_API_POOL_SIZE":      "20",
		"JANUSLY_WORKER_POOL_SIZE":   "40",
	}))
	if err != nil {
		t.Fatalf("load explicit: %v", err)
	}
	if explicit.APIPoolSize != 20 || explicit.WorkerPoolSize != 40 {
		t.Fatalf("explicit pool sizes wrong: %+v", explicit)
	}
	derived, err := Load(env(map[string]string{"JANUSLY_WORKER_CONCURRENCY": "32"}))
	if err != nil {
		t.Fatalf("load derived: %v", err)
	}
	if derived.WorkerPoolSize != 34 {
		t.Fatalf("derived worker pool must scale with concurrency: %d", derived.WorkerPoolSize)
	}
}

func TestAuthoringExperienceProcessFlagIsStrictAndDefaultOff(t *testing.T) {
	for _, value := range []string{"", " ", "false", "true", " true "} {
		cfg, err := Load(env(map[string]string{"JANUSLY_AUTHORING_EXPERIENCE_ENABLED": value}))
		if err != nil || cfg.AuthoringExperienceEnabled != (strings.TrimSpace(value) == "true") {
			t.Fatalf("flag %q: %v %v", value, cfg.AuthoringExperienceEnabled, err)
		}
	}
	for _, value := range []string{"TRUE", "1", "yes", "PRIVATE_SECRET_VALUE"} {
		_, err := Load(env(map[string]string{"JANUSLY_AUTHORING_EXPERIENCE_ENABLED": value}))
		if err == nil || !strings.Contains(err.Error(), "JANUSLY_AUTHORING_EXPERIENCE_ENABLED") || strings.Contains(err.Error(), value) {
			t.Fatalf("unsafe invalid flag response: %v", err)
		}
	}
}

func TestAuthoringExperienceModeIsExplicitStrictAndDefaultOff(t *testing.T) {
	for _, input := range []string{"", " ", "off", "shadow", "review", " review "} {
		cfg, err := Load(env(map[string]string{"JANUSLY_AUTHORING_EXPERIENCE_MODE": input}))
		want := strings.TrimSpace(input)
		if want == "" {
			want = "off"
		}
		if err != nil || string(cfg.AuthoringExperienceMode) != want {
			t.Fatalf("mode %q: got=%q error=%v", input, cfg.AuthoringExperienceMode, err)
		}
		if cfg.AuthoringExperienceEnabled {
			t.Fatal("choosing a mode silently enabled the independent registry gate")
		}
	}
	for _, input := range []string{"REVIEW", "true", "1", "adaptive", "PRIVATE_MODE_VALUE"} {
		_, err := Load(env(map[string]string{"JANUSLY_AUTHORING_EXPERIENCE_MODE": input}))
		if err == nil || !strings.Contains(err.Error(), "JANUSLY_AUTHORING_EXPERIENCE_MODE") || strings.Contains(err.Error(), input) {
			t.Fatalf("unsafe invalid mode response: %v", err)
		}
	}
}

// Development auth headers let any caller act as any user, so while they are
// accepted the API listens on loopback unless a wildcard bind is acknowledged.
func TestDevAuthHeadersKeepTheListenerOnLoopback(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		host    string
		refused bool
	}{
		{"local defaults", map[string]string{}, "127.0.0.1", false},
		{"explicit dev headers in production", map[string]string{"JANUSLY_ENV": "production", "ALLOW_DEV_AUTH_HEADERS": "true"}, "127.0.0.1", false},
		{"identity provider", map[string]string{"SUPABASE_URL": "https://auth.example.test"}, "", false},
		{"blank identity provider, as the resolver reads it", map[string]string{"SUPABASE_URL": " "}, "", false},
		{"production with identity provider", map[string]string{"JANUSLY_ENV": "production", "SUPABASE_URL": "https://auth.example.test"}, "", false},
		{"loopback kept", map[string]string{"JANUSLY_HTTP_HOST": "::1"}, "::1", false},
		{"wildcard refused", map[string]string{"JANUSLY_HTTP_HOST": "0.0.0.0"}, "", true},
		{"IPv6 wildcard refused", map[string]string{"JANUSLY_HTTP_HOST": "::"}, "", true},
		{"wildcard acknowledged", map[string]string{"JANUSLY_HTTP_HOST": "0.0.0.0", "ALLOW_DEV_AUTH_HEADERS_ON_NETWORK": "true"}, "0.0.0.0", false},
		{"wildcard with identity provider", map[string]string{"JANUSLY_HTTP_HOST": "0.0.0.0", "SUPABASE_URL": "https://auth.example.test"}, "0.0.0.0", false},
	}
	for _, tc := range cases {
		cfg, err := Load(env(tc.env))
		if tc.refused {
			if err == nil || !strings.Contains(err.Error(), "ALLOW_DEV_AUTH_HEADERS_ON_NETWORK=true") {
				t.Fatalf("%s: want a refusal naming the flag, got %v", tc.name, err)
			}
			continue
		}
		if err != nil || cfg.HTTPHost != tc.host {
			t.Fatalf("%s: host %q err %v, want %q", tc.name, cfg.HTTPHost, err, tc.host)
		}
	}
}
