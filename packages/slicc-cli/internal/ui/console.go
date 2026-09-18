package ui

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)



type Kind uint8


const (
	KindInfo Kind = iota
	KindOk
	KindWarn
	KindError
	KindExec
	KindTool
)





const (
	eraseLine = "\r\x1b[2K"
	cursorUp  = "\x1b[1A"
)




const minRepaint = 80 * time.Millisecond


const tapeBucketTicks = 5


type Options struct {
	
	Mode Mode
	
	
	Tag string
	
	
	Width func() int
	
	Now func() time.Time
	
	Tick time.Duration
}





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
	
	
	lastMsg   string
	lastKind  Kind
	lastCount int
	
	
	
	
	lastRows int
	
	
	
	repeatRow bool
	stopped   bool

	stop chan struct{}
	done chan struct{}
}


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


func (c *Console) Mode() Mode { return c.mode }



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



func (c *Console) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	stop, done := c.stop, c.done
	c.mu.Unlock()

	
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


func (c *Console) Snapshot() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}


func (c *Console) Beat() {
	c.Update(func(s *Status) { s.LastBeat = c.now() })
}


func (c *Console) CountDiag() {
	c.Update(func(s *Status) { s.Diags++ })
}




func (c *Console) Line(kind Kind, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writeEntryLocked(kind, msg)
}





func (c *Console) Note(kind Kind, format string, args ...any) {
	if c.mode.Sticky {
		return
	}
	c.Line(kind, format, args...)
}



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



func (c *Console) repeatMarker(kind Kind) string {
	glyph, style := kindLook(c.mode, kind)
	count := fmt.Sprintf("%s repeated (%s%d)", c.mode.Glyph(GlyphRepeat), multiplySign(c.mode), c.lastCount)
	return fmt.Sprintf("%s %s %s",
		c.mode.Paint(StyleDim, c.now().Format("15:04:05")),
		c.mode.Paint(style, glyph),
		c.mode.Paint(StyleDim, count))
}



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


func (c *Console) renderEntry(kind Kind, msg string, count int) []string {
	glyph, style := kindLook(c.mode, kind)
	stamp := c.now().Format("15:04:05")
	parts := strings.Split(strings.TrimRight(msg, "\n"), "\n")

	head := fmt.Sprintf("%s %s %s", c.mode.Paint(StyleDim, stamp), c.mode.Paint(style, glyph), parts[0])
	if count > 1 {
		head += c.mode.Paint(StyleDim, fmt.Sprintf(" (%s%d)", multiplySign(c.mode), count))
	}
	rows := []string{head}
	
	
	indent := strings.Repeat(" ", len(stamp)+1)
	for _, part := range parts[1:] {
		rows = append(rows, indent+c.mode.Paint(StyleDim, c.mode.Glyph(GlyphContinuation)+" "+part))
	}
	return rows
}




const maxRewritableRows = 6






func (c *Console) rewritableRows(rows []string) int {
	if len(rows) == 0 || len(rows) > maxRewritableRows {
		return 0
	}
	width := c.widthLocked()
	for _, row := range rows {
		if !rewriteSafe(row) || visibleWidth(row) >= width {
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



const maxPartialLine = 8 << 10




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

	
	
	for _, line := range lines {
		w.console.Line(w.kind, "%s", strings.TrimRight(line, "\r"))
	}
	return len(p), nil
}
