package ui

import (
	"fmt"
	"strings"
	"time"
)

// State is the connection state shown in the status bar's badge.
type State uint8

// Connection states, in the order a follower moves through them.
const (
	StateConnecting State = iota
	StateConnected
	StateRetrying
	StateOffline
)

// Status is the model behind the status bar. It is owned by a Console and only
// ever mutated inside Console.Update, which holds the console lock — the
// counters are bumped from pion goroutines and the bar is repainted from a
// ticker.
type Status struct {
	// Started is the launch time the uptime counter counts from.
	Started time.Time
	// State is the current connection state.
	State State
	// RetryAt is when the next attempt fires (StateRetrying only); it drives a
	// live countdown rather than a one-off "reconnecting in 30s" line.
	RetryAt time.Time
	// Attempt counts consecutive failed attempts (reset on a connect).
	Attempt int
	// Sessions counts successful connections; everything after the first is a
	// reconnect. Zero means this process never reached the leader, which is why
	// it also gates the closing summary.
	Sessions int
	// Execs counts leader-issued commands run in this process.
	Execs int
	// Diags counts pion records suppressed into the diagnostic logger — the
	// TURN/ICE churn that used to scroll past as `turnc ERROR:` lines.
	Diags int
	// LastBeat is when the leader's last keepalive arrived (zero = none yet).
	LastBeat time.Time
	// Peer describes who the leader would run commands as, e.g.
	// "alice@laptop · bash -c".
	Peer string

	tape tape
}

// segment is one styled span of the status bar. The bar is assembled as
// segments so it can be truncated by display width without cutting an escape
// sequence in half.
type segment struct {
	text  string
	style Style
}

// render lays out the status bar for the given moment and caps it at width
// cells. frame animates the spinner.
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
	// Clamped as a whole as well as per field: Peer carries a hostname and a
	// runner command, and cellWidth cannot know how wide a terminal draws an
	// "ambiguous width" character in either. One cell too many wraps the bar, and
	// a wrapped bar pushes the log up on every repaint, so the width wins.
	return truncateVisible(joinSegments(m, segs, width), width)
}

// badge is the leading state indicator: a colored dot for a settled state, a
// spinner while a connection is in flight, and a live countdown while waiting
// to retry.
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

// beatStyle ages the heartbeat field: the leader pings on a timer, so a beat
// that stops arriving is the earliest sign of a half-open channel.
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

// joinSegments lays fields out left to right within width, skipping any that no
// longer fit. A field that is skipped does not disqualify the ones after it: on
// a narrow terminal a long hostname would otherwise hide the short, useful
// fields that follow it.
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

// tapeCells is how many buckets of connection history the bar shows.
const tapeCells = 16

// tape is a fixed-size history strip of connection state, one cell per bucket,
// newest on the right — a glanceable answer to "has this link been stable?"
// that costs one character per bucket.
type tape struct {
	cells   [tapeCells]State
	filled  int
	pending State
	// hasPending marks a bucket in progress; the worst state seen in a bucket
	// wins, so a blip inside it cannot be hidden by a recovery.
	hasPending bool
}

// sample folds one observation into the bucket in progress.
func (t *tape) sample(state State) {
	if !t.hasPending || state > t.pending {
		t.pending = state
		t.hasPending = true
	}
}

// commit closes the bucket in progress and pushes it onto the strip.
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

// CompactDuration formats a duration for a status bar: one or two units, no
// fractions, always short enough to sit next to a dozen other fields.
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
