// Package logging is the CLI's structured diagnostic logger, built on
// log/slog. It is deliberately separate from the CLI's *user-facing* output:
// `prompt`/`exec`/`watch` stream the leader's bytes straight to stdout/stderr
// and never route through here. Only diagnostics (signaling retries, ICE
// failures, dropped frames) do.
//
// Configuration is environment-driven so a single binary can be turned up in
// the field without flags:
//
//	SLICC_LOG_LEVEL=debug|info|warn|error   explicit level (enables logging)
//	SLICC_LOG_FORMAT=text|json              handler, default text
//	SLICC_DEBUG=1                           legacy switch, equivalent to level=debug
//
// With none of them set the logger is disabled and every call is a cheap no-op.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
)

// Environment variables read by ConfigFromEnv.
const (
	EnvLevel  = "SLICC_LOG_LEVEL"
	EnvFormat = "SLICC_LOG_FORMAT"
	EnvDebug  = "SLICC_DEBUG"
)

// Config is a resolved logger configuration.
type Config struct {
	// Enabled reports whether any record should be emitted at all.
	Enabled bool
	// Level is the minimum record level emitted when Enabled.
	Level slog.Level
	// JSON selects slog.JSONHandler instead of slog.TextHandler.
	JSON bool
}

// ParseLevel maps a case-insensitive level name to an slog.Level.
func ParseLevel(name string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}

// LookupEnv matches os.LookupEnv; injected so tests need no process env.
type LookupEnv func(string) (string, bool)

// ConfigFromEnv resolves a Config from the SLICC_LOG_* / SLICC_DEBUG variables.
func ConfigFromEnv(lookup LookupEnv) Config {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	cfg := Config{Level: slog.LevelInfo}
	if raw, ok := lookup(EnvFormat); ok && strings.EqualFold(strings.TrimSpace(raw), "json") {
		cfg.JSON = true
	}
	if raw, ok := lookup(EnvLevel); ok && strings.TrimSpace(raw) != "" {
		level, valid := ParseLevel(raw)
		cfg.Enabled = true
		cfg.Level = level
		if !valid {
			cfg.Level = slog.LevelDebug
		}
		return cfg
	}
	if raw, ok := lookup(EnvDebug); ok && raw != "" {
		cfg.Enabled = true
		cfg.Level = slog.LevelDebug
	}
	return cfg
}

// Logger emits structured diagnostics. A nil *Logger is a valid no-op logger,
// so callers never need a nil check.
type Logger struct {
	slog    *slog.Logger
	enabled bool
}

// New builds a Logger writing to w. A disabled Config yields a no-op Logger.
func New(w io.Writer, cfg Config) *Logger {
	if !cfg.Enabled || w == nil {
		return &Logger{}
	}
	opts := &slog.HandlerOptions{Level: cfg.Level}
	var handler slog.Handler
	if cfg.JSON {
		handler = slog.NewJSONHandler(w, opts)
	} else {
		handler = slog.NewTextHandler(w, opts)
	}
	return &Logger{slog: slog.New(handler), enabled: true}
}

// NewFromEnv builds a Logger writing to w, configured from the process env.
func NewFromEnv(w io.Writer) *Logger {
	return New(w, ConfigFromEnv(os.LookupEnv))
}

// Enabled reports whether records are emitted.
func (l *Logger) Enabled() bool {
	return l != nil && l.enabled
}

// EnabledAt reports whether a record at level would be emitted. It lets a hot
// producer skip building a record the handler would only drop — pion emits a
// trace record per STUN packet, and formatting all of them to discard them is
// pure waste in the default silent build.
func (l *Logger) EnabledAt(level slog.Level) bool {
	if !l.Enabled() {
		return false
	}
	return l.slog.Enabled(context.Background(), level)
}

// With returns a Logger that adds attrs to every record.
func (l *Logger) With(args ...any) *Logger {
	if !l.Enabled() || len(args) == 0 {
		return l
	}
	return &Logger{slog: l.slog.With(args...), enabled: true}
}

func (l *Logger) log(level slog.Level, msg string, args ...any) {
	if !l.Enabled() {
		return
	}
	l.slog.Log(context.Background(), level, msg, args...)
}

// Debug emits a debug record.
func (l *Logger) Debug(msg string, args ...any) { l.log(slog.LevelDebug, msg, args...) }

// Info emits an info record.
func (l *Logger) Info(msg string, args ...any) { l.log(slog.LevelInfo, msg, args...) }

// Warn emits a warning record.
func (l *Logger) Warn(msg string, args ...any) { l.log(slog.LevelWarn, msg, args...) }

// Error emits an error record.
func (l *Logger) Error(msg string, args ...any) { l.log(slog.LevelError, msg, args...) }

// Logf adapts the Logger to the `func(format string, args ...any)` seam used by
// tray.Options.Logf and attachWait. The formatted string becomes the record
// message at debug level.
func (l *Logger) Logf(format string, args ...any) {
	if !l.Enabled() {
		return
	}
	l.log(slog.LevelDebug, fmt.Sprintf(format, args...))
}
