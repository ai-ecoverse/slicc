package logging

import (
	"fmt"
	"log/slog"

	pionlogging "github.com/pion/logging"
)

// PionEvent is the optional structured tap on a pion record. It runs on
// whatever pion goroutine produced the record (an ICE agent, a TURN client's
// refresh loop), so implementations must be non-blocking and concurrency-safe.
type PionEvent func(scope string, level slog.Level, msg string)

// PionFactory adapts this package's diagnostic logging to the
// pion/logging.LoggerFactory that webrtc.SettingEngine accepts.
//
// Installing it matters for presentation, not just plumbing: with
// SettingEngine.LoggerFactory left nil, webrtc installs
// pion/logging.NewDefaultLoggerFactory(), which writes every record at error
// level straight to os.Stderr — so a flaky TURN allocation buries the CLI's own
// output under `turnc ERROR: Fail to refresh permissions: …` lines that no
// SLICC_LOG_LEVEL can turn off. Routed through here they are diagnostics: quiet
// by default, back with SLICC_DEBUG=1, and countable via event.
func PionFactory(logf func(format string, args ...any), event PionEvent) pionlogging.LoggerFactory {
	return &pionFactory{logf: logf, event: event}
}

type pionFactory struct {
	logf  func(format string, args ...any)
	event PionEvent
}

func (f *pionFactory) NewLogger(scope string) pionlogging.LeveledLogger {
	return &pionLogger{scope: scope, factory: f}
}

// pionLogger is one scope's ("turnc", "ice", "sctp") sink.
type pionLogger struct {
	scope   string
	factory *pionFactory
}

func (l *pionLogger) emit(level slog.Level, msg string) {
	if l.factory.logf != nil {
		l.factory.logf("pion %s: %s", l.scope, msg)
	}
	if l.factory.event != nil {
		l.factory.event(l.scope, level, msg)
	}
}

func (l *pionLogger) emitf(level slog.Level, format string, args ...any) {
	// Formatting is skipped entirely when nothing consumes the record — pion
	// traces every STUN packet at trace level.
	if l.factory.logf == nil && l.factory.event == nil {
		return
	}
	l.emit(level, fmt.Sprintf(format, args...))
}

func (l *pionLogger) Trace(msg string)                  { l.emit(slog.LevelDebug, msg) }
func (l *pionLogger) Tracef(format string, args ...any) { l.emitf(slog.LevelDebug, format, args...) }
func (l *pionLogger) Debug(msg string)                  { l.emit(slog.LevelDebug, msg) }
func (l *pionLogger) Debugf(format string, args ...any) { l.emitf(slog.LevelDebug, format, args...) }
func (l *pionLogger) Info(msg string)                   { l.emit(slog.LevelInfo, msg) }
func (l *pionLogger) Infof(format string, args ...any)  { l.emitf(slog.LevelInfo, format, args...) }
func (l *pionLogger) Warn(msg string)                   { l.emit(slog.LevelWarn, msg) }
func (l *pionLogger) Warnf(format string, args ...any)  { l.emitf(slog.LevelWarn, format, args...) }
func (l *pionLogger) Error(msg string)                  { l.emit(slog.LevelError, msg) }
func (l *pionLogger) Errorf(format string, args ...any) { l.emitf(slog.LevelError, format, args...) }
