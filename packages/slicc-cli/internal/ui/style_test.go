package ui

import (
	"strings"
	"testing"
)

func TestPaint(t *testing.T) {
	colored := Mode{Color: true}
	if got := colored.Paint(StyleRed, "boom"); got != "\x1b[31mboom\x1b[0m" {
		t.Errorf("colored paint = %q", got)
	}
	if got := colored.Paint(StyleNone, "plain"); got != "plain" {
		t.Errorf("StyleNone must not wrap, got %q", got)
	}
	if got := colored.Paint(StyleRed, ""); got != "" {
		t.Errorf("empty text must stay empty, got %q", got)
	}
	if got := (Mode{}).Paint(StyleRed, "boom"); got != "boom" {
		t.Errorf("plain paint = %q, want the bare text", got)
	}
}

func TestGlyphFallsBackToASCII(t *testing.T) {
	if got := (Mode{Unicode: true}).Glyph(GlyphOk); got != "✔" {
		t.Errorf("unicode glyph = %q", got)
	}
	if got := (Mode{}).Glyph(GlyphOk); got != "+" {
		t.Errorf("ascii glyph = %q", got)
	}
	if got := (Mode{}).Glyph(Glyph(200)); got != "" {
		t.Errorf("unknown glyph = %q, want empty", got)
	}
	// Width accounting assumes single-cell glyphs in both sets.
	for g := range glyphs {
		for _, mode := range []Mode{{Unicode: true}, {}} {
			if w := visibleWidth(mode.Glyph(g)); w != 1 {
				t.Errorf("glyph %d in %+v is %d cells, want 1", g, mode, w)
			}
		}
	}
}

func TestSpinnerWraps(t *testing.T) {
	mode := Mode{Unicode: true}
	if mode.spinner(0) != mode.spinner(len(spinnerUnicode)) {
		t.Error("spinner must cycle")
	}
	if got := (Mode{}).spinner(-1); got == "" {
		t.Error("a negative frame must still render a frame")
	}
}

func TestVisibleWidthIgnoresEscapes(t *testing.T) {
	cases := map[string]int{
		"abc":                   3,
		"\x1b[31mabc\x1b[0m":    3,
		"✔ ok":                  4,
		"\x1b[1;32m✔\x1b[0m ok": 4,
		"":                      0,
		"\x1b[2K":               0,
		"\x1bincomplete":        10, // a bare ESC consumes only itself; the rest counts
	}
	for in, want := range cases {
		if got := visibleWidth(in); got != want {
			t.Errorf("visibleWidth(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestTruncateVisible(t *testing.T) {
	if got := truncateVisible("abcdef", 3); got != "abc" {
		t.Errorf("plain truncate = %q", got)
	}
	if got := truncateVisible("abc", 10); got != "abc" {
		t.Errorf("short input must pass through, got %q", got)
	}
	if got := truncateVisible("abc", 0); got != "" {
		t.Errorf("zero limit = %q, want empty", got)
	}
	// A cut inside styled text must not leak the style into whatever follows.
	got := truncateVisible("\x1b[31mabcdef\x1b[0m", 3)
	if visibleWidth(got) != 3 {
		t.Errorf("styled truncate kept %d cells, want 3 (%q)", visibleWidth(got), got)
	}
	if !strings.HasSuffix(got, sgrReset) {
		t.Errorf("styled truncate must end reset, got %q", got)
	}
	// Multi-byte runes are never split.
	if got := truncateVisible("♥♥♥♥", 2); got != "♥♥" {
		t.Errorf("multibyte truncate = %q, want ♥♥", got)
	}
}

func TestCellWidthCountsTerminalCells(t *testing.T) {
	cases := map[rune]int{
		'a':      1,
		'✔':      1, // our own symbols are single-cell
		'界':      2, // CJK unified
		'ｗ':      2, // fullwidth form
		'한':      2, // Hangul syllable
		'🚀':      2, // emoji
		'\u0301': 0, // combining acute
		'\ufe0f': 0, // variation selector
		'\u200d': 0, // zero-width joiner
	}
	for r, want := range cases {
		if got := cellWidth(r); got != want {
			t.Errorf("cellWidth(%q) = %d, want %d", r, got, want)
		}
	}
}

func TestVisibleWidthMeasuresWideAndCombiningRunes(t *testing.T) {
	// Two double-wide runes plus an accented "e" whose mark adds nothing.
	if got := visibleWidth("世界e\u0301"); got != 5 {
		t.Errorf("visibleWidth = %d, want 5", got)
	}
	// Styling still costs nothing.
	if got := visibleWidth("\x1b[31m世\x1b[0m"); got != 2 {
		t.Errorf("visibleWidth with color = %d, want 2", got)
	}
}

func TestTruncateVisibleKeepsWideRunesWhole(t *testing.T) {
	// One cell left over: the next rune needs two, so it is dropped rather than
	// half-written — a split cell is exactly what makes a terminal wrap.
	got := truncateVisible("a世界", 2)
	if got != "a" {
		t.Errorf("truncateVisible = %q, want %q", got, "a")
	}
	if got := truncateVisible("a世界", 3); got != "a世" {
		t.Errorf("truncateVisible = %q, want %q", got, "a世")
	}
}

func TestRewriteSafeOnlyTrustsRunesWeControl(t *testing.T) {
	safe := []string{
		"12:00:00 + connected",
		"12:00:00 ✔ connected",                   // our glyph
		"\x1b[2m12:00:00\x1b[0m ↺ repeated (×3)", // the repeat marker
		"⠋ connecting  up 4s  ♥ 0s  ▁▄███",       // every bar symbol
	}
	for _, s := range safe {
		if !rewriteSafe(s) {
			t.Errorf("rewriteSafe(%q) = false, want true", s)
		}
	}
	unsafe := []string{
		"tray attach failed: 世界", // leader text a CJK locale may draw wide
		"deploy 🚀 failed",        // emoji width is terminal-specific
		"combining e\u0301",      // a mark whose placement we cannot verify
		"tab\there",              // a control character moves the cursor
		"bad utf8: \xff",         // replaced by a glyph of the terminal's choosing
	}
	for _, s := range unsafe {
		if rewriteSafe(s) {
			t.Errorf("rewriteSafe(%q) = true, want false", s)
		}
	}
}
