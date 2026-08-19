package ui

import (
	"strings"
	"unicode/utf8"
)

// Style is a semantic text style resolved to ANSI SGR codes (or dropped when
// color is off).
type Style uint8

// The palette. Deliberately limited to the 8 basic colors plus dim/bold, which
// every terminal since the 1980s renders and every user color scheme remaps.
const (
	StyleNone Style = iota
	StyleDim
	StyleBold
	StyleRed
	StyleGreen
	StyleYellow
	StyleBlue
	StyleCyan
	StyleMagenta
	StyleBoldGreen
	StyleBoldRed
	StyleBoldCyan
)

var sgr = map[Style]string{
	StyleDim:       "\x1b[2m",
	StyleBold:      "\x1b[1m",
	StyleRed:       "\x1b[31m",
	StyleGreen:     "\x1b[32m",
	StyleYellow:    "\x1b[33m",
	StyleBlue:      "\x1b[34m",
	StyleCyan:      "\x1b[36m",
	StyleMagenta:   "\x1b[35m",
	StyleBoldGreen: "\x1b[1;32m",
	StyleBoldRed:   "\x1b[1;31m",
	StyleBoldCyan:  "\x1b[1;36m",
}

const sgrReset = "\x1b[0m"

// Paint wraps s in style when the mode allows color, and returns it untouched
// otherwise.
func (m Mode) Paint(style Style, s string) string {
	code, ok := sgr[style]
	if !m.Color || !ok || s == "" {
		return s
	}
	return code + s + sgrReset
}

// Glyph is a semantic symbol with an ASCII fallback for terminals whose
// encoding cannot be assumed UTF-8.
type Glyph uint8

// The symbol set.
const (
	GlyphOk Glyph = iota
	GlyphWarn
	GlyphError
	GlyphExec
	GlyphTool
	GlyphInfo
	GlyphConnected
	GlyphConnecting
	GlyphRetry
	GlyphOffline
	GlyphBeat
	GlyphReconnect
	GlyphBlockFull
	GlyphBlockHalf
	GlyphBlockLow
	GlyphSeparator
	GlyphContinuation
	GlyphRepeat
)

var glyphs = map[Glyph][2]string{
	// {unicode, ascii}
	GlyphOk:           {"✔", "+"},
	GlyphWarn:         {"⚠", "!"},
	GlyphError:        {"✖", "x"},
	GlyphExec:         {"▸", ">"},
	GlyphTool:         {"⚙", "*"},
	GlyphInfo:         {"·", "-"},
	GlyphConnected:    {"●", "*"},
	GlyphConnecting:   {"◌", "o"},
	GlyphRetry:        {"⟳", "~"},
	GlyphOffline:      {"○", "."},
	GlyphBeat:         {"♥", "^"},
	GlyphReconnect:    {"⇅", "@"},
	GlyphBlockFull:    {"█", "#"},
	GlyphBlockHalf:    {"▄", "="},
	GlyphBlockLow:     {"▁", "_"},
	GlyphSeparator:    {"·", "|"},
	GlyphContinuation: {"│", "|"},
	GlyphRepeat:       {"↺", "~"},
}

// Glyph renders g for the mode's encoding.
func (m Mode) Glyph(g Glyph) string {
	pair, ok := glyphs[g]
	if !ok {
		return ""
	}
	if m.Unicode {
		return pair[0]
	}
	return pair[1]
}

// spinnerFrames animate a pending connection; the braille set is smooth, the
// ASCII set is the classic four-frame twirl.
var (
	spinnerUnicode = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	spinnerASCII   = []string{"|", "/", "-", "\\"}
)

func (m Mode) spinner(frame int) string {
	set := spinnerASCII
	if m.Unicode {
		set = spinnerUnicode
	}
	return set[((frame%len(set))+len(set))%len(set)]
}

// visibleWidth counts the display cells a rendered string occupies, skipping
// ANSI escape sequences. Every glyph in this package is single-cell, so runes
// are cells.
func visibleWidth(s string) int {
	width := 0
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			i += escapeLen(s[i:])
			continue
		}
		i += runeLen(s[i:])
		width++
	}
	return width
}

// truncateVisible caps s at limit display cells, keeping escape sequences whole
// and appending a reset so a cut inside styled text cannot leak color into the
// rest of the line.
func truncateVisible(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	var b strings.Builder
	width, styled := 0, false
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			n := escapeLen(s[i:])
			b.WriteString(s[i : i+n])
			styled = true
			i += n
			continue
		}
		if width == limit {
			if styled {
				b.WriteString(sgrReset)
			}
			return b.String()
		}
		size := runeLen(s[i:])
		b.WriteString(s[i : i+size])
		i += size
		width++
	}
	return b.String()
}

// escapeLen returns the byte length of the escape sequence at the start of s
// (CSI sequences end at their final byte; anything else counts as one byte so
// scanning always advances).
func escapeLen(s string) int {
	if len(s) < 2 || s[1] != '[' {
		return 1
	}
	for i := 2; i < len(s); i++ {
		if s[i] >= 0x40 && s[i] <= 0x7e {
			return i + 1
		}
	}
	return len(s)
}

// runeLen returns the byte length of the rune at the start of s. An invalid byte
// counts as one cell, so width accounting never stalls on malformed input.
func runeLen(s string) int {
	if _, size := utf8.DecodeRuneInString(s); size > 0 {
		return size
	}
	return 1
}
