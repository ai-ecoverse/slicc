// Package ui renders the CLI's human-facing status output: colored event lines
// and a sticky one-line status bar for the long-running verbs (`follow`,
// `watch`).
//
// It is deliberately dependency-free (raw ANSI + stdlib) and degrades in one
// step: when the target stream is not an interactive terminal — a pipe, a log
// file, CI — Mode collapses to plain mode, where every line is written exactly
// as the pre-TUI CLI wrote it ("slicc follow: connected") with no escape
// sequences and no cursor movement. Machine-readable output must never depend
// on a terminal being attached.
//
// Environment:
//
//	SLICC_NO_TUI=1    plain mode even on a terminal (also `--plain`)
//	NO_COLOR          keep the status bar, drop the colors
//	FORCE_COLOR       colors even when the stream is not a terminal
//	COLUMNS           overrides the detected terminal width
package ui

import (
	"os"
	"strings"
)

// EnvNoTUI disables all terminal decoration when set to a non-empty, non-"0"
// value.
const EnvNoTUI = "SLICC_NO_TUI"

// Env matches os.LookupEnv; injected so tests need no process env.
type Env func(string) (string, bool)

// Mode is the resolved presentation capability of one output stream. The zero
// value is plain mode: no color, no status bar, ASCII only.
type Mode struct {
	// Color allows ANSI SGR sequences.
	Color bool
	// Sticky allows cursor movement — the repainted status bar and in-place
	// line updates. Only ever true for an interactive terminal.
	Sticky bool
	// Unicode allows the non-ASCII glyph set.
	Unicode bool
}

// Detect resolves the presentation mode for f.
func Detect(f *os.File, env Env) Mode {
	if env == nil {
		env = os.LookupEnv
	}
	if v, ok := env(EnvNoTUI); ok && v != "" && v != "0" {
		return Mode{}
	}
	term, _ := env("TERM")
	// TERM=dumb promises no escape-sequence support at all; an unset TERM on a
	// real terminal is common on Windows, so it is not disqualifying.
	dumb := term == "dumb"
	tty := IsTerminal(f) && !dumb

	color := tty
	if v, ok := env("NO_COLOR"); ok && v != "" {
		color = false
	}
	if forcedColor(env) {
		color = !dumb
	}
	return Mode{Color: color, Sticky: tty, Unicode: unicodeCapable(env)}
}

// Plain reports whether the mode carries no decoration at all.
func (m Mode) Plain() bool { return !m.Color && !m.Sticky }

func forcedColor(env Env) bool {
	for _, key := range []string{"FORCE_COLOR", "CLICOLOR_FORCE"} {
		if v, ok := env(key); ok && v != "" && v != "0" {
			return true
		}
	}
	return false
}

// unicodeCapable reports whether the terminal's encoding can be assumed UTF-8.
// A wrong guess is not cosmetic on a legacy code page: glyphs turn into
// multi-cell mojibake that breaks the status bar's width accounting.
func unicodeCapable(env Env) bool {
	for _, key := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if v, ok := env(key); ok && v != "" {
			lower := strings.ToLower(v)
			return strings.Contains(lower, "utf-8") || strings.Contains(lower, "utf8")
		}
	}
	// Windows sets no locale variables; the modern terminals that do set these
	// are UTF-8, the legacy console is not.
	if _, ok := env("WT_SESSION"); ok {
		return true
	}
	if _, ok := env("TERM_PROGRAM"); ok {
		return true
	}
	return false
}

// IsTerminal reports whether f is an interactive terminal. A character device
// alone is not enough (/dev/null is one), so the terminal must also answer a
// window-size query.
func IsTerminal(f *os.File) bool {
	if f == nil {
		return false
	}
	info, err := f.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	if _, ok := terminalSize(f); !ok {
		return false
	}
	return prepareTerminal(f)
}

// DefaultWidth is the width assumed when a terminal reports none.
const DefaultWidth = 80

// Width returns the usable column count for f, honoring a COLUMNS override.
func Width(f *os.File, env Env) int {
	if env == nil {
		env = os.LookupEnv
	}
	if v, ok := env("COLUMNS"); ok {
		if n := atoiSafe(v); n > 0 {
			return n
		}
	}
	if n, ok := terminalSize(f); ok && n > 0 {
		return n
	}
	return DefaultWidth
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
		if n > 1<<16 {
			return 0
		}
	}
	return n
}
