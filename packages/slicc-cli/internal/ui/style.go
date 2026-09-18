package ui

import (
	"strings"
	"unicode"
	"unicode/utf8"
)



type Style uint8



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



func (m Mode) Paint(style Style, s string) string {
	code, ok := sgr[style]
	if !m.Color || !ok || s == "" {
		return s
	}
	return code + s + sgrReset
}



type Glyph uint8


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









var wideRanges = [][2]rune{
	{0x1100, 0x115F},   
	{0x2E80, 0x303E},   
	{0x3041, 0x33FF},   
	{0x3400, 0x4DBF},   
	{0x4E00, 0x9FFF},   
	{0xA000, 0xA4CF},   
	{0xA960, 0xA97F},   
	{0xAC00, 0xD7A3},   
	{0xF900, 0xFAFF},   
	{0xFE10, 0xFE19},   
	{0xFE30, 0xFE6F},   
	{0xFF00, 0xFF60},   
	{0xFFE0, 0xFFE6},   
	{0x1F300, 0x1F64F}, 
	{0x1F680, 0x1F6FF}, 
	{0x1F900, 0x1F9FF}, 
	{0x1FA70, 0x1FAFF}, 
	{0x20000, 0x3FFFD}, 
}






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












func rewriteSafe(s string) bool {
	for i := 0; i < len(s); {
		if s[i] == 0x1b {
			i += escapeLen(s[i:])
			continue
		}
		r, size := decodeRune(s[i:])
		i += size
		if r < 0x20 || r == 0x7f {
			return false 
		}
		if r < 0x80 || ownRunes[r] {
			continue
		}
		return false
	}
	return true
}




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




func decodeRune(s string) (rune, int) {
	r, size := utf8.DecodeRuneInString(s)
	if size == 0 {
		return utf8.RuneError, 1
	}
	return r, size
}
