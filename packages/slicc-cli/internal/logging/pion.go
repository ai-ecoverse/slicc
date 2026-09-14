package logging

import (
	"fmt"
	"log/slog"

	pionlogging "github.com/pion/logging"
)









type PionEvent func(scope string, level slog.Level, msg string)


const eventLevel = slog.LevelWarn

















func PionFactory(logf func(format string, args ...any), event PionEvent, wanted func(slog.Level) bool) pionlogging.LoggerFactory {
	return &pionFactory{logf: logf, event: event, wanted: wanted}
}

type pionFactory struct {
	logf   func(format string, args ...any)
	event  PionEvent
	wanted func(slog.Level) bool
}


func (f *pionFactory) logs(level slog.Level) bool {
	return f.logf != nil && (f.wanted == nil || f.wanted(level))
}


func (f *pionFactory) consumes(level slog.Level) bool {
	return f.logs(level) || (f.event != nil && level >= eventLevel)
}

func (f *pionFactory) NewLogger(scope string) pionlogging.LeveledLogger {
	return &pionLogger{scope: scope, factory: f}
}


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
