package ui

import (
	"strings"
	"unicode"
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
// ANSI escape sequences.
func visibleWidth(s string) int {
	width := 0
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			i += escapeLen(s[i:])
			continue
		}
		r, size := decodeRune(s[i:])
		i += size
		width += cellWidth(r)
	}
	return width
}

// wideRanges are the code points a terminal draws two cells wide: the East Asian
// Wide and Fullwidth blocks, plus the emoji blocks that are almost universally
// double-width. Sorted; searched by bisection.
//
// It does not cover the Unicode "ambiguous width" class (which depends on the
// terminal's locale), so a stray such character can still be undercounted by
// one cell. That is why anything beyond this package's own symbols disqualifies
// a row from being rewritten — see rewriteSafe.
var wideRanges = [][2]rune{
	{0x1100, 0x115F},   // Hangul Jamo
	{0x2E80, 0x303E},   // CJK radicals, Kangxi, CJK symbols
	{0x3041, 0x33FF},   // Kana, Bopomofo, Hangul compat, CJK compat
	{0x3400, 0x4DBF},   // CJK ext A
	{0x4E00, 0x9FFF},   // CJK unified
	{0xA000, 0xA4CF},   // Yi
	{0xA960, 0xA97F},   // Hangul Jamo ext A
	{0xAC00, 0xD7A3},   // Hangul syllables
	{0xF900, 0xFAFF},   // CJK compat ideographs
	{0xFE10, 0xFE19},   // vertical forms
	{0xFE30, 0xFE6F},   // CJK compat forms
	{0xFF00, 0xFF60},   // fullwidth forms
	{0xFFE0, 0xFFE6},   // fullwidth signs
	{0x1F300, 0x1F64F}, // emoji: symbols, pictographs, emoticons
	{0x1F680, 0x1F6FF}, // emoji: transport
	{0x1F900, 0x1F9FF}, // emoji: supplemental
	{0x1FA70, 0x1FAFF}, // emoji: extended
	{0x20000, 0x3FFFD}, // CJK ext B and beyond
}

// cellWidth reports the terminal cells r occupies. Combining marks, variation
// selectors and other zero-width code points add nothing (they decorate the
// previous cell), the wide ranges take two, everything else one. Getting this
// wrong breaks the bar's truncation and, worse, the row arithmetic behind an
// in-place rewrite.
func cellWidth(r rune) int {
	if r == 0 {
		return 0
	}
	if r < 0x80 {
		return 1
	}
	if unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf) {
		return 0
	}
	lo, hi := 0, len(wideRanges)-1
	for lo <= hi {
		mid := (lo + hi) / 2
		switch {
		case r < wideRanges[mid][0]:
			hi = mid - 1
		case r > wideRanges[mid][1]:
			lo = mid + 1
		default:
			return 2
		}
	}
	return 1
}

// ownRunes are the non-ASCII runes this package itself emits. Their width is
// known (one cell each), which is what makes a row containing them safe to
// rewrite in place.
var ownRunes = func() map[rune]bool {
	set := map[rune]bool{'×': true}
	add := func(s string) {
		for _, r := range s {
			set[r] = true
		}
	}
	for _, pair := range glyphs {
		add(pair[0])
		add(pair[1])
	}
	for _, frame := range spinnerUnicode {
		add(frame)
	}
	return set
}()

// rewriteSafe reports whether every cell in s has a width this package can be
// sure of, so the row count that follows from it can be trusted.
//
// Leader-supplied text (an error body, a scoop name) may hold anything: emoji
// ZWJ sequences, "ambiguous width" characters a CJK locale draws wide, a rune
// the terminal replaces with a box of its own choosing. Undercount such a row
// and it silently soft-wraps, at which point walking the cursor up by the row
// count lands mid-event and erases someone else's output. Rather than guess, a
// row that is not plain ASCII plus our own symbols is never rewritten — it
// collapses into the compact repeat marker instead, which is built only from
// runes we control.
func rewriteSafe(s string) bool {
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			i += escapeLen(s[i:])
			continue
		}
		r, size := decodeRune(s[i:])
		i += size
		if r < 0x20 || r == 0x7f {
			return false // a control character moves the cursor unpredictably
		}
		if r < 0x80 || ownRunes[r] {
			continue
		}
		return false
	}
	return true
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
		r, size := decodeRune(s[i:])
		// A double-wide rune with one cell left is dropped rather than split:
		// half a cell is what makes a terminal wrap.
		if width+cellWidth(r) > limit {
			if styled {
				b.WriteString(sgrReset)
			}
			return b.String()
		}
		b.WriteString(s[i : i+size])
		i += size
		width += cellWidth(r)
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

// decodeRune returns the rune at the start of s and its byte length. An invalid
// byte decodes as utf8.RuneError over one byte, so scanning always advances and
// malformed input is measured as the replacement character the terminal shows.
func decodeRune(s string) (rune, int) {
	r, size := utf8.DecodeRuneInString(s)
	if size == 0 {
		return utf8.RuneError, 1
	}
	return r, size
}
