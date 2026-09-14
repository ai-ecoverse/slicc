package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func envFrom(pairs map[string]string) LookupEnv {
	return func(key string) (string, bool) {
		v, ok := pairs[key]
		return v, ok
	}
}

func TestParseLevel(t *testing.T) {
	cases := map[string]struct {
		level slog.Level
		valid bool
	}{
		"debug":    {slog.LevelDebug, true},
		"DEBUG":    {slog.LevelDebug, true},
		" info ":   {slog.LevelInfo, true},
		"warn":     {slog.LevelWarn, true},
		"warning":  {slog.LevelWarn, true},
		"error":    {slog.LevelError, true},
		"nonsense": {slog.LevelInfo, false},
	}
	for name, want := range cases {
		got, valid := ParseLevel(name)
		if got != want.level || valid != want.valid {
			t.Errorf("ParseLevel(%q) = (%v, %v), want (%v, %v)", name, got, valid, want.level, want.valid)
		}
	}
}

func TestConfigFromEnvDisabledByDefault(t *testing.T) {
	cfg := ConfigFromEnv(envFrom(nil))
	if cfg.Enabled {
		t.Fatalf("expected logging disabled with no env, got %+v", cfg)
	}
}

func TestConfigFromEnvLegacyDebugSwitch(t *testing.T) {
	cfg := ConfigFromEnv(envFrom(map[string]string{EnvDebug: "1"}))
	if !cfg.Enabled || cfg.Level != slog.LevelDebug || cfg.JSON {
		t.Fatalf("SLICC_DEBUG=1 should enable text debug logging, got %+v", cfg)
	}
}

func TestConfigFromEnvEmptyDebugStaysDisabled(t *testing.T) {
	cfg := ConfigFromEnv(envFrom(map[string]string{EnvDebug: ""}))
	if cfg.Enabled {
		t.Fatalf("empty SLICC_DEBUG should not enable logging, got %+v", cfg)
	}
}

func TestConfigFromEnvExplicitLevelAndFormat(t *testing.T) {
	cfg := ConfigFromEnv(envFrom(map[string]string{EnvLevel: "warn", EnvFormat: "JSON"}))
	if !cfg.Enabled || cfg.Level != slog.LevelWarn || !cfg.JSON {
		t.Fatalf("expected enabled warn+json, got %+v", cfg)
	}
}

func TestConfigFromEnvUnknownLevelFallsBackToDebug(t *testing.T) {
	cfg := ConfigFromEnv(envFrom(map[string]string{EnvLevel: "chatty"}))
	if !cfg.Enabled || cfg.Level != slog.LevelDebug {
		t.Fatalf("unknown level should enable debug, got %+v", cfg)
	}
}

func TestConfigFromEnvLevelOverridesDebugSwitch(t *testing.T) {
	cfg := ConfigFromEnv(envFrom(map[string]string{EnvDebug: "1", EnvLevel: "error"}))
	if cfg.Level != slog.LevelError {
		t.Fatalf("SLICC_LOG_LEVEL should win over SLICC_DEBUG, got %+v", cfg)
	}
}

func TestConfigFromEnvNilLookupUsesProcessEnv(t *testing.T) {
	t.Setenv(EnvLevel, "info")
	cfg := ConfigFromEnv(nil)
	if !cfg.Enabled || cfg.Level != slog.LevelInfo {
		t.Fatalf("nil lookup should read the process env, got %+v", cfg)
	}
}

func TestDisabledLoggerWritesNothing(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, Config{})
	log.Debug("d")
	log.Info("i")
	log.Warn("w")
	log.Error("e")
	log.Logf("f %d", 1)
	if log.Enabled() {
		t.Fatal("expected disabled logger")
	}
	if buf.Len() != 0 {
		t.Fatalf("disabled logger wrote %q", buf.String())
	}
}

func TestNilWriterYieldsDisabledLogger(t *testing.T) {
	if New(nil, Config{Enabled: true}).Enabled() {
		t.Fatal("nil writer should yield a disabled logger")
	}
}

func TestNilLoggerIsNoOp(t *testing.T) {
	var log *Logger
	log.Info("no panic")
	log.Logf("no panic %s", "either")
	if log.Enabled() {
		t.Fatal("nil logger should report disabled")
	}
	if log.With("k", "v") != nil {
		t.Fatal("With on a nil logger should stay nil")
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, Config{Enabled: true, Level: slog.LevelWarn})
	log.Debug("hidden-debug")
	log.Info("hidden-info")
	log.Warn("shown-warn")
	out := buf.String()
	if strings.Contains(out, "hidden") {
		t.Fatalf("records below the level leaked: %q", out)
	}
	if !strings.Contains(out, "shown-warn") {
		t.Fatalf("warn record missing: %q", out)
	}
}

func TestLogfFormatsAsMessage(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, Config{Enabled: true, Level: slog.LevelDebug, JSON: true})
	log.Logf("tray attach: retrying in %dms", 250)

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("json handler produced non-JSON %q: %v", buf.String(), err)
	}
	if rec["msg"] != "tray attach: retrying in 250ms" {
		t.Fatalf("unexpected msg: %v", rec["msg"])
	}
	if rec["level"] != "DEBUG" {
		t.Fatalf("unexpected level: %v", rec["level"])
	}
}

func TestWithAddsAttributes(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, Config{Enabled: true, Level: slog.LevelInfo, JSON: true}).With("component", "tray")
	log.Info("connected", "bootstrap", "abc")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("unmarshal %q: %v", buf.String(), err)
	}
	if rec["component"] != "tray" || rec["bootstrap"] != "abc" {
		t.Fatalf("attributes missing: %v", rec)
	}
}

func TestWithNoArgsReturnsSameLogger(t *testing.T) {
	log := New(&bytes.Buffer{}, Config{Enabled: true})
	if log.With() != log {
		t.Fatal("With() with no args should return the receiver")
	}
}

func TestNewFromEnvHonorsProcessEnv(t *testing.T) {
	t.Setenv(EnvDebug, "1")
	t.Setenv(EnvFormat, "text")
	var buf bytes.Buffer
	log := NewFromEnv(&buf)
	if !log.Enabled() {
		t.Fatal("expected SLICC_DEBUG to enable the logger")
	}
	log.Debug("hello")
	if !strings.Contains(buf.String(), "level=DEBUG") || !strings.Contains(buf.String(), "msg=hello") {
		t.Fatalf("unexpected text output: %q", buf.String())
	}
}
