













package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
)


const (
	EnvLevel  = "SLICC_LOG_LEVEL"
	EnvFormat = "SLICC_LOG_FORMAT"
	EnvDebug  = "SLICC_DEBUG"
)


type Config struct {
	
	Enabled bool
	
	Level slog.Level
	
	JSON bool
}


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


type LookupEnv func(string) (string, bool)


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



type Logger struct {
	slog    *slog.Logger
	enabled bool
}


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


func NewFromEnv(w io.Writer) *Logger {
	return New(w, ConfigFromEnv(os.LookupEnv))
}


func (l *Logger) Enabled() bool {
	return l != nil && l.enabled
}





func (l *Logger) EnabledAt(level slog.Level) bool {
	if !l.Enabled() {
		return false
	}
	return l.slog.Enabled(context.Background(), level)
}


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


func (l *Logger) Debug(msg string, args ...any) { l.log(slog.LevelDebug, msg, args...) }


func (l *Logger) Info(msg string, args ...any) { l.log(slog.LevelInfo, msg, args...) }


func (l *Logger) Warn(msg string, args ...any) { l.log(slog.LevelWarn, msg, args...) }


func (l *Logger) Error(msg string, args ...any) { l.log(slog.LevelError, msg, args...) }




func (l *Logger) Logf(format string, args ...any) {
	if !l.Enabled() {
		return
	}
	l.log(slog.LevelDebug, fmt.Sprintf(format, args...))
}
