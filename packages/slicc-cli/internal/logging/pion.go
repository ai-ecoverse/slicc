package logging

import (
	"fmt"
	"log/slog"

	pionlogging "github.com/pion/logging"
)

// PionEvent is the optional structured tap on a pion record at warn level or
// above — the link problems worth summarizing. Lower levels are pion's running
// commentary (a trace record per STUN packet) and never reach it, so the tap
// costs nothing on a healthy connection.
//
// It runs on whatever pion goroutine produced the record (an ICE agent, a TURN
// client's refresh loop), so implementations must be non-blocking and
// concurrency-safe.
type PionEvent func(scope string, level slog.Level, msg string)

// eventLevel is the lowest level PionEvent receives.
const eventLevel = slog.LevelWarn

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
//
// wanted reports whether logf would do anything with a record at that level;
// nil means it takes everything. Supplying it is what keeps the adapter cheap:
// logf is normally a live closure over a *disabled* logger, so without wanted
// every one of pion's per-packet trace records gets formatted just to be
// dropped one call later.
func PionFactory(logf func(format string, args ...any), event PionEvent, wanted func(slog.Level) bool) pionlogging.LoggerFactory {
	return &pionFactory{logf: logf, event: event, wanted: wanted}
}

type pionFactory struct {
	logf   func(format string, args ...any)
	event  PionEvent
	wanted func(slog.Level) bool
}

// logs reports whether a record at level reaches logf.
func (f *pionFactory) logs(level slog.Level) bool {
	return f.logf != nil && (f.wanted == nil || f.wanted(level))
}

// consumes reports whether anything at all is waiting for a record at level.
func (f *pionFactory) consumes(level slog.Level) bool {
	return f.logs(level) || (f.event != nil && level >= eventLevel)
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
	if l.factory.logs(level) {
		l.factory.logf("pion %s: %s", l.scope, msg)
	}
	if l.factory.event != nil && level >= eventLevel {
		l.factory.event(l.scope, level, msg)
	}
}

func (l *pionLogger) emitf(level slog.Level, format string, args ...any) {
	// Formatting is skipped entirely when nothing is waiting for the record.
	if !l.factory.consumes(level) {
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
