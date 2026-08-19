package ui

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// Kind classifies an event line: it picks the glyph and color, and nothing
// else. Plain mode ignores it entirely, so a kind is never load-bearing.
type Kind uint8

// Event kinds.
const (
	KindInfo Kind = iota
	KindOk
	KindWarn
	KindError
	KindExec
	KindTool
)

// ANSI control sequences used by the sticky line. Deliberately the smallest
// possible set: erase-line plus one-line-up, no alternate screen buffer and no
// scroll regions, so output still scrolls back normally and a killed process
// leaves the terminal usable.
const (
	eraseLine = "\r\x1b[2K"
	cursorUp  = "\x1b[1A"
)

// minRepaint throttles bar repaints triggered by state changes; a burst of
// counter updates (pion retrying a TURN allocation) must not turn into a burst
// of writes. The ticker paints the pending state within one tick anyway.
const minRepaint = 80 * time.Millisecond

// tapeBucketTicks is how many ticks one history cell covers.
const tapeBucketTicks = 5

// Options configures a Console.
type Options struct {
	// Mode is the resolved capability of the target stream.
	Mode Mode
	// Tag prefixes every line in plain mode ("slicc follow"), reproducing the
	// CLI's pre-TUI output verbatim.
	Tag string
	// Width reports the current terminal width; nil assumes DefaultWidth.
	// Called per repaint so a resized window needs no signal handler.
	Width func() int
	// Now overrides the clock (tests).
	Now func() time.Time
	// Tick is the status-bar repaint interval (0 = one second).
	Tick time.Duration
}

// Console renders event lines and, on an interactive terminal, keeps a status
// bar pinned below them. Every method is safe to call from any goroutine: lines
// arrive from the data-channel reader, counters from pion's internals, repaints
// from the ticker.
type Console struct {
	w     io.Writer
	mode  Mode
	tag   string
	width func() int
	now   func() time.Time
	tick  time.Duration

	mu       sync.Mutex
	status   Status
	frame    int
	bucket   int
	barShown bool
	lastPain time.Time
	// last* track the most recent event so an identical repeat can be folded
	// into it instead of scrolling a wall of the same message.
	lastMsg   string
	lastKind  Kind
	lastCount int
	// lastRows is how many terminal rows that event occupies, since rewriting it
	// walks the cursor back up exactly that far. Zero means "not rewritable"
	// (a wrapped or oversized event), which disables collapsing rather than
	// risking a cursor walk over rows that are no longer where we left them.
	lastRows int
	// repeatRow marks that the row on screen is a compact repeat marker rather
	// than the event itself — what an event too tall or too wide to rewrite in
	// place collapses into.
	repeatRow bool
	stopped   bool

	stop chan struct{}
	done chan struct{}
}

// New builds a Console writing to w.
func New(w io.Writer, opts Options) *Console {
	c := &Console{
		w:     w,
		mode:  opts.Mode,
		tag:   opts.Tag,
		width: opts.Width,
		now:   opts.Now,
		tick:  opts.Tick,
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.width == nil {
		c.width = func() int { return DefaultWidth }
	}
	if c.tick <= 0 {
		c.tick = time.Second
	}
	c.status = Status{Started: c.now(), State: StateConnecting}
	return c
}

// Mode reports the console's resolved presentation mode.
func (c *Console) Mode() Mode { return c.mode }

// Start begins repainting the status bar. It is a no-op in plain mode, so
// callers need no conditionals.
func (c *Console) Start() {
	if !c.mode.Sticky {
		return
	}
	c.mu.Lock()
	if c.stop != nil || c.stopped {
		c.mu.Unlock()
		return
	}
	c.stop, c.done = make(chan struct{}), make(chan struct{})
	stop, done := c.stop, c.done
	c.mu.Unlock()
	go c.run(stop, done)
}

// Stop removes the status bar and stops repainting. Later lines still print (a
// closing summary), just without a bar. Safe to call more than once.
func (c *Console) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	stop, done := c.stop, c.done
	c.mu.Unlock()

	// The ticker goroutine takes the same lock, so it is joined unlocked.
	if stop != nil {
		close(stop)
		<-done
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.barShown {
		fmt.Fprint(c.w, eraseLine)
		c.barShown = false
	}
}

func (c *Console) run(stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(c.tick)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			c.mu.Lock()
			c.frame++
			c.status.tape.sample(c.status.State)
			c.bucket++
			if c.bucket >= tapeBucketTicks {
				c.bucket = 0
				c.status.tape.commit()
			}
			c.paintBarLocked(true)
			c.mu.Unlock()
		}
	}
}

// Update mutates the status model and refreshes the bar.
func (c *Console) Update(mutate func(*Status)) {
	if mutate == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	mutate(&c.status)
	c.status.tape.sample(c.status.State)
	c.paintBarLocked(false)
}

// Snapshot copies the status model, for a closing summary.
func (c *Console) Snapshot() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

// Beat records an inbound keepalive.
func (c *Console) Beat() {
	c.Update(func(s *Status) { s.LastBeat = c.now() })
}

// CountDiag records one suppressed link diagnostic.
func (c *Console) CountDiag() {
	c.Update(func(s *Status) { s.Diags++ })
}

// Line prints one event. A multi-line message (an HTTP body quoted into an
// error) stays one event: the first line is stamped and marked, the rest are
// indented continuations.
func (c *Console) Line(kind Kind, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writeEntryLocked(kind, msg)
}

// Note prints a line only when there is no status bar. It is for information the
// bar already carries live — the wait before the next reconnect, which the badge
// counts down — where a line per occurrence would both duplicate the bar and,
// by interleaving, stop the identical errors around it from collapsing.
func (c *Console) Note(kind Kind, format string, args ...any) {
	if c.mode.Sticky {
		return
	}
	c.Line(kind, format, args...)
}

// Raw prints text (which may span lines) with no glyph, timestamp or plain-mode
// tag — for the startup banner, whose layout is its own.
func (c *Console) Raw(style Style, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.clearBarLocked()
	fmt.Fprint(c.w, c.mode.Paint(style, text))
	if !strings.HasSuffix(text, "\n") {
		fmt.Fprintln(c.w)
	}
	c.resetDedupLocked()
	c.paintBarLocked(true)
}

func (c *Console) writeEntryLocked(kind Kind, msg string) {
	if !c.mode.Sticky {
		// The classic one-line-per-event form, colored when the stream can take
		// it. Newlines inside msg are left as they are and nothing is collapsed,
		// so a redirected stream reads exactly as it did before this package
		// existed — byte for byte, since Paint is a no-op without color.
		_, style := kindLook(c.mode, kind)
		if c.tag != "" {
			msg = c.tag + ": " + msg
		}
		fmt.Fprintln(c.w, c.mode.Paint(style, msg))
		return
	}
	if c.lastCount > 0 && c.lastMsg == msg && c.lastKind == kind {
		c.collapseRepeatLocked(kind, msg)
		return
	}
	rows := c.renderEntry(kind, msg, 1)
	c.emitRowsLocked(rows, 0)
	c.lastKind, c.lastMsg, c.lastCount = kind, msg, 1
	c.lastRows = c.rewritableRows(rows)
	c.repeatRow = false
}

// collapseRepeatLocked accounts for one more occurrence of the event already on
// screen instead of scrolling a duplicate. A reconnect loop against a dead
// leader repeats the same error every few seconds; without this the interesting
// lines above scroll away.
//
// A small event is rewritten in place with a "(×3)" counter. An event too tall
// or too wide for that keeps its detail on screen once and collapses into a
// compact repeat marker, which is itself rewritten from then on — so the wall of
// a wrapped multi-line error costs one extra row, no matter how long the leader
// stays unreachable.
func (c *Console) collapseRepeatLocked(kind Kind, msg string) {
	c.lastCount++
	if !c.repeatRow && c.lastRows > 0 {
		rows := c.renderEntry(kind, msg, c.lastCount)
		if len(rows) == c.lastRows && c.rewritableRows(rows) == c.lastRows {
			c.emitRowsLocked(rows, c.lastRows)
			return
		}
	}
	rewind := 0
	if c.repeatRow {
		rewind = c.lastRows
	}
	marker := []string{c.repeatMarker(kind)}
	c.emitRowsLocked(marker, rewind)
	c.lastRows = c.rewritableRows(marker)
	c.repeatRow = c.lastRows > 0
}

// repeatMarker is the one-row stand-in for an event that cannot be rewritten
// where it sits.
func (c *Console) repeatMarker(kind Kind) string {
	glyph, style := kindLook(c.mode, kind)
	count := fmt.Sprintf("%s repeated (%s%d)", c.mode.Glyph(GlyphRepeat), multiplySign(c.mode), c.lastCount)
	return fmt.Sprintf("%s %s %s",
		c.mode.Paint(StyleDim, c.now().Format("15:04:05")),
		c.mode.Paint(style, glyph),
		c.mode.Paint(StyleDim, count))
}

// emitRowsLocked writes rows, first walking the cursor back over rewind rows to
// replace what is there.
func (c *Console) emitRowsLocked(rows []string, rewind int) {
	c.clearBarLocked()
	if rewind > 0 {
		fmt.Fprintf(c.w, "\x1b[%dA", rewind)
	}
	for _, row := range rows {
		if rewind > 0 {
			fmt.Fprint(c.w, eraseLine)
		}
		fmt.Fprintln(c.w, row)
	}
	c.paintBarLocked(true)
}

// renderEntry lays one event out as terminal rows.
func (c *Console) renderEntry(kind Kind, msg string, count int) []string {
	glyph, style := kindLook(c.mode, kind)
	stamp := c.now().Format("15:04:05")
	parts := strings.Split(strings.TrimRight(msg, "\n"), "\n")

	head := fmt.Sprintf("%s %s %s", c.mode.Paint(StyleDim, stamp), c.mode.Paint(style, glyph), parts[0])
	if count > 1 {
		head += c.mode.Paint(StyleDim, fmt.Sprintf(" (%s%d)", multiplySign(c.mode), count))
	}
	rows := []string{head}
	// Continuations line up under the message and are marked, not stamped: the
	// event happened once, so it reads as one event.
	indent := strings.Repeat(" ", len(stamp)+1)
	for _, part := range parts[1:] {
		rows = append(rows, indent+c.mode.Paint(StyleDim, c.mode.Glyph(GlyphContinuation)+" "+part))
	}
	return rows
}

// maxRewritableRows bounds how tall an event may be and still be collapsed in
// place. A rewrite walks the cursor up, which is only sound while the event is
// still on screen; a short pane and a long event are not worth the risk.
const maxRewritableRows = 6

// rewritableRows reports how many rows the event occupies for the purpose of
// rewriting it, or 0 when it must not be rewritten: a row at or past the
// terminal width has soft-wrapped, so the row count no longer matches what the
// terminal actually did.
func (c *Console) rewritableRows(rows []string) int {
	if len(rows) == 0 || len(rows) > maxRewritableRows {
		return 0
	}
	width := c.widthLocked()
	for _, row := range rows {
		if visibleWidth(row) >= width {
			return 0
		}
	}
	return len(rows)
}

func multiplySign(m Mode) string {
	if m.Unicode {
		return "×"
	}
	return "x"
}

func kindLook(m Mode, kind Kind) (glyph string, style Style) {
	switch kind {
	case KindOk:
		return m.Glyph(GlyphOk), StyleGreen
	case KindWarn:
		return m.Glyph(GlyphWarn), StyleYellow
	case KindError:
		return m.Glyph(GlyphError), StyleRed
	case KindExec:
		return m.Glyph(GlyphExec), StyleCyan
	case KindTool:
		return m.Glyph(GlyphTool), StyleMagenta
	default:
		return m.Glyph(GlyphInfo), StyleDim
	}
}

func (c *Console) clearBarLocked() {
	if !c.barShown {
		return
	}
	fmt.Fprint(c.w, eraseLine)
	c.barShown = false
}

func (c *Console) resetDedupLocked() {
	c.lastCount, c.lastMsg, c.lastRows, c.repeatRow = 0, "", 0, false
}

func (c *Console) paintBarLocked(force bool) {
	if !c.mode.Sticky || c.stopped {
		return
	}
	now := c.now()
	if !force && c.barShown && now.Sub(c.lastPain) < minRepaint {
		return
	}
	// One cell short of the width: a bar that fills the last column makes some
	// terminals wrap to a new row, which would push the log up on every repaint.
	bar := c.status.render(c.mode, now, c.frame, c.widthLocked()-1)
	fmt.Fprint(c.w, eraseLine+bar)
	c.barShown = true
	c.lastPain = now
}

func (c *Console) widthLocked() int {
	w := c.width()
	if w <= 0 {
		return DefaultWidth
	}
	return w
}

// maxPartialLine bounds a LineWriter's buffer so a runner that never emits a
// newline cannot grow it without limit.
const maxPartialLine = 8 << 10

// LineWriter adapts the console to an io.Writer that expects to write whole
// lines, so components holding an io.Writer (follow.Session's per-command log)
// need no console awareness.
func (c *Console) LineWriter(kind Kind) io.Writer {
	return &lineWriter{console: c, kind: kind}
}

type lineWriter struct {
	console *Console
	kind    Kind

	mu  sync.Mutex
	buf []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.buf = append(w.buf, p...)
	var lines []string
	for {
		idx := bytes.IndexByte(w.buf, '\n')
		if idx < 0 {
			break
		}
		lines = append(lines, string(w.buf[:idx]))
		w.buf = w.buf[idx+1:]
	}
	if len(w.buf) > maxPartialLine {
		lines = append(lines, string(w.buf))
		w.buf = w.buf[:0]
	}
	w.mu.Unlock()

	// Emitted outside the writer's lock: Line takes the console lock, and a
	// console repaint must never wait on a writer.
	for _, line := range lines {
		w.console.Line(w.kind, "%s", strings.TrimRight(line, "\r"))
	}
	return len(p), nil
}
