package ui

import (
	"fmt"
	"strings"
	"time"
)


type State uint8


const (
	StateConnecting State = iota
	StateConnected
	StateRetrying
	StateOffline
)





type Status struct {
	
	Started time.Time
	
	State State
	
	
	RetryAt time.Time
	
	Attempt int
	
	
	
	Sessions int
	
	Execs int
	
	
	Diags int
	
	LastBeat time.Time
	
	
	Peer string

	tape tape
}




type segment struct {
	text  string
	style Style
}



func (s *Status) render(m Mode, now time.Time, frame, width int) string {
	segs := []segment{s.badge(m, now, frame)}
	segs = append(segs, segment{"up " + CompactDuration(now.Sub(s.Started)), StyleDim})
	if !s.LastBeat.IsZero() {
		segs = append(segs, segment{
			fmt.Sprintf("%s %s", m.Glyph(GlyphBeat), CompactDuration(now.Sub(s.LastBeat))),
			beatStyle(now.Sub(s.LastBeat)),
		})
	}
	if s.Execs > 0 {
		segs = append(segs, segment{fmt.Sprintf("%s %d execs", m.Glyph(GlyphExec), s.Execs), StyleCyan})
	}
	if s.Sessions > 1 {
		segs = append(segs, segment{
			fmt.Sprintf("%s %d reconnects", m.Glyph(GlyphReconnect), s.Sessions-1), StyleDim,
		})
	}
	if s.Diags > 0 {
		segs = append(segs, segment{
			fmt.Sprintf("link %s %d", m.Glyph(GlyphWarn), s.Diags), StyleYellow,
		})
	}
	if s.Peer != "" {
		segs = append(segs, segment{s.Peer, StyleDim})
	}
	if tape := s.tape.render(m); tape != "" {
		segs = append(segs, segment{tape, StyleNone})
	}
	
	
	
	
	return truncateVisible(joinSegments(m, segs, width), width)
}




func (s *Status) badge(m Mode, now time.Time, frame int) segment {
	switch s.State {
	case StateConnected:
		return segment{m.Glyph(GlyphConnected) + " connected", StyleBoldGreen}
	case StateConnecting:
		label := "connecting"
		if s.Attempt > 0 {
			label = fmt.Sprintf("reconnecting (try %d)", s.Attempt+1)
		}
		return segment{m.spinner(frame) + " " + label, StyleYellow}
	case StateRetrying:
		wait := time.Duration(0)
		if !s.RetryAt.IsZero() && s.RetryAt.After(now) {
			wait = s.RetryAt.Sub(now)
		}
		return segment{
			fmt.Sprintf("%s retry in %s", m.Glyph(GlyphRetry), CompactDuration(wait.Round(time.Second))),
			StyleYellow,
		}
	default:
		return segment{m.Glyph(GlyphOffline) + " offline", StyleBoldRed}
	}
}



func beatStyle(age time.Duration) Style {
	switch {
	case age < 30*time.Second:
		return StyleGreen
	case age < 90*time.Second:
		return StyleYellow
	default:
		return StyleRed
	}
}





func joinSegments(m Mode, segs []segment, width int) string {
	const sep = "  "
	var b strings.Builder
	used := 0
	for _, seg := range segs {
		if seg.text == "" {
			continue
		}
		cost := visibleWidth(seg.text)
		if used > 0 {
			cost += len(sep)
		}
		if used+cost > width {
			continue
		}
		if used > 0 {
			b.WriteString(sep)
		}
		b.WriteString(m.Paint(seg.style, seg.text))
		used += cost
	}
	return b.String()
}


const tapeCells = 16




type tape struct {
	cells   [tapeCells]State
	filled  int
	pending State
	
	
	hasPending bool
}


func (t *tape) sample(state State) {
	if !t.hasPending || state > t.pending {
		t.pending = state
		t.hasPending = true
	}
}


func (t *tape) commit() {
	if !t.hasPending {
		return
	}
	copy(t.cells[:], t.cells[1:])
	t.cells[tapeCells-1] = t.pending
	if t.filled < tapeCells {
		t.filled++
	}
	t.hasPending = false
}

func (t *tape) render(m Mode) string {
	if t.filled == 0 {
		return ""
	}
	var b strings.Builder
	for _, state := range t.cells[tapeCells-t.filled:] {
		switch state {
		case StateConnected:
			b.WriteString(m.Paint(StyleGreen, m.Glyph(GlyphBlockFull)))
		case StateConnecting, StateRetrying:
			b.WriteString(m.Paint(StyleYellow, m.Glyph(GlyphBlockHalf)))
		default:
			b.WriteString(m.Paint(StyleRed, m.Glyph(GlyphBlockLow)))
		}
	}
	return b.String()
}



func CompactDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		return fmt.Sprintf("%dd%02dh", int(d.Hours())/24, int(d.Hours())%24)
	}
}
