package ui

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a strings.Builder that survives the ticker goroutine writing
// while a test reads.
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// fixedClock returns a clock that advances one second per reading, so
// timestamps are deterministic but distinguishable.
func fixedClock() func() time.Time {
	base := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	calls := 0
	return func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return base.Add(time.Duration(calls) * time.Second)
	}
}

func plainConsole(w *syncBuffer) *Console {
	return New(w, Options{Tag: "slicc follow", Now: fixedClock()})
}

func stickyConsole(w *syncBuffer, width int) *Console {
	return New(w, Options{
		Mode:  Mode{Sticky: true, Unicode: true},
		Tag:   "slicc follow",
		Width: func() int { return width },
		Now:   fixedClock(),
	})
}

func TestPlainModeReproducesTheClassicLines(t *testing.T) {
	var buf syncBuffer
	c := plainConsole(&buf)
	c.Start() // must be inert without a terminal
	c.Line(KindOk, "connected")
	c.Line(KindError, "%s", "tray attach failed")
	c.Update(func(s *Status) { s.State = StateConnected; s.Sessions++ })
	c.Stop()

	want := "slicc follow: connected\nslicc follow: tray attach failed\n"
	if got := buf.String(); got != want {
		t.Errorf("plain output = %q, want %q", got, want)
	}
}

func TestPlainModeKeepsMultiLineMessagesIntact(t *testing.T) {
	var buf syncBuffer
	plainConsole(&buf).Line(KindError, "attach failed (body: {\n  \"code\": \"NOPE\"\n})")
	want := "slicc follow: attach failed (body: {\n  \"code\": \"NOPE\"\n})\n"
	if got := buf.String(); got != want {
		t.Errorf("plain output = %q, want %q", got, want)
	}
}

func TestPlainModeWithoutTag(t *testing.T) {
	var buf syncBuffer
	New(&buf, Options{Now: fixedClock()}).Line(KindInfo, "bare")
	if got := buf.String(); got != "bare\n" {
		t.Errorf("untagged output = %q", got)
	}
}

func TestPlainModeRepeatsAreNotCollapsed(t *testing.T) {
	// A redirected stream is somebody's log: every occurrence must be in it.
	var buf syncBuffer
	c := plainConsole(&buf)
	for i := 0; i < 3; i++ {
		c.Line(KindError, "same")
	}
	if got := strings.Count(buf.String(), "same"); got != 3 {
		t.Errorf("logged %d occurrences, want 3", got)
	}
}

func TestNoteOnlyPrintsWithoutABar(t *testing.T) {
	var plain, sticky syncBuffer
	plainConsole(&plain).Note(KindInfo, "reconnecting in 2s…")
	stickyConsole(&sticky, 80).Note(KindInfo, "reconnecting in 2s…")

	if !strings.Contains(plain.String(), "reconnecting in 2s…") {
		t.Error("plain mode must keep the retry note")
	}
	if strings.Contains(sticky.String(), "reconnecting") {
		t.Error("the status bar counts the retry down; the note must be dropped")
	}
}

func TestStickyLineCarriesStampGlyphAndBar(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 80)
	c.Update(func(s *Status) { s.State = StateConnected; s.Sessions = 1 })
	c.Line(KindOk, "connected")

	out := buf.String()
	if !strings.Contains(out, "✔ connected") {
		t.Errorf("output %q is missing the marked line", out)
	}
	if !strings.Contains(out, "12:00:") {
		t.Errorf("output %q is missing a timestamp", out)
	}
	if !strings.Contains(out, "● connected") {
		t.Errorf("output %q is missing the status bar", out)
	}
	if !strings.Contains(out, eraseLine) {
		t.Errorf("output %q never erases the bar before writing", out)
	}
}

func TestStickyMultiLineIsOneEvent(t *testing.T) {
	var buf syncBuffer
	stickyConsole(&buf, 200).Line(KindError, "attach failed:\n  detail one\n  detail two")
	out := buf.String()
	if got := strings.Count(out, "✖"); got != 1 {
		t.Errorf("marked %d rows, want 1 (%q)", got, out)
	}
	if got := strings.Count(out, "│"); got != 2 {
		t.Errorf("continued %d rows, want 2 (%q)", got, out)
	}
}

func TestStickyRepeatIsRewrittenInPlace(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 80)
	c.Line(KindError, "boom")
	c.Line(KindError, "boom")
	c.Line(KindError, "boom")

	out := buf.String()
	if !strings.Contains(out, "(×3)") {
		t.Errorf("output %q is missing the repeat counter", out)
	}
	if strings.Contains(out, "(×2)") && strings.Contains(out, "(×3)") {
		// Both may appear: each rewrite prints a new counter over the old row.
		if got := strings.Count(out, cursorUp); got < 2 {
			t.Errorf("output %q rewrote in place %d times, want 2", out, got)
		}
	}
	if got := strings.Count(out, "\x1b[1A"); got != 2 {
		t.Errorf("walked the cursor up %d times, want 2 (%q)", got, out)
	}
}

func TestStickyWideRepeatCollapsesToAMarker(t *testing.T) {
	// A message wider than the terminal soft-wraps, so its rows cannot be
	// rewritten; the repeats must still not scroll the screen away.
	var buf syncBuffer
	c := stickyConsole(&buf, 24)
	long := strings.Repeat("wide error ", 6)
	for i := 0; i < 4; i++ {
		c.Line(KindError, "%s", long)
	}
	out := buf.String()
	if got := strings.Count(out, long); got != 1 {
		t.Errorf("printed the long message %d times, want 1", got)
	}
	if !strings.Contains(out, "↺ repeated (×4)") {
		t.Errorf("output %q is missing the repeat marker", out)
	}
}

func TestStickyTallRepeatCollapsesToAMarker(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 200)
	tall := "head\n" + strings.Repeat("body\n", maxRewritableRows+2)
	c.Line(KindError, "%s", tall)
	c.Line(KindError, "%s", tall)
	if !strings.Contains(buf.String(), "↺ repeated (×2)") {
		t.Errorf("output %q is missing the repeat marker", buf.String())
	}
}

func TestStickyDifferentMessageResetsCollapsing(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 80)
	c.Line(KindError, "first")
	c.Line(KindError, "first")
	c.Line(KindWarn, "first") // same text, different kind: a different event
	c.Line(KindError, "second")
	out := buf.String()
	if !strings.Contains(out, "⚠ first") {
		t.Errorf("output %q lost the differently-marked line", out)
	}
	if !strings.Contains(out, "✖ second") {
		t.Errorf("output %q lost the new line", out)
	}
}

func TestRawKeepsTextVerbatim(t *testing.T) {
	var buf syncBuffer
	plainConsole(&buf).Raw(StyleBoldCyan, "  banner art  ")
	if got := buf.String(); got != "  banner art  \n" {
		t.Errorf("raw output = %q", got)
	}
}

func TestRawPaintsWhenColored(t *testing.T) {
	var buf syncBuffer
	New(&buf, Options{Mode: Mode{Color: true}, Now: fixedClock()}).Raw(StyleRed, "warning\n")
	if got := buf.String(); got != "\x1b[31mwarning\n\x1b[0m" {
		t.Errorf("raw colored output = %q", got)
	}
}

func TestRawBreaksCollapsing(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 80)
	c.Line(KindError, "boom")
	c.Raw(StyleNone, "----")
	c.Line(KindError, "boom")
	if strings.Contains(buf.String(), "×2") {
		t.Error("a raw write sits between the two events; they must not be merged")
	}
}

func TestLineWriterSplitsOnNewlines(t *testing.T) {
	var buf syncBuffer
	w := plainConsole(&buf).LineWriter(KindExec)
	if _, err := w.Write([]byte("exec: ls\nexec: pwd\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := w.Write([]byte("exec: partial")); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := buf.String()
	if out != "slicc follow: exec: ls\nslicc follow: exec: pwd\n" {
		t.Errorf("line writer output = %q", out)
	}
	if _, err := w.Write([]byte(" done\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !strings.Contains(buf.String(), "slicc follow: exec: partial done\n") {
		t.Errorf("a line split across writes must be joined, got %q", buf.String())
	}
}

func TestLineWriterTrimsCarriageReturns(t *testing.T) {
	var buf syncBuffer
	w := plainConsole(&buf).LineWriter(KindExec)
	_, _ = w.Write([]byte("windows line\r\n"))
	if got := buf.String(); got != "slicc follow: windows line\n" {
		t.Errorf("output = %q", got)
	}
}

func TestLineWriterFlushesAnEndlessLine(t *testing.T) {
	var buf syncBuffer
	w := plainConsole(&buf).LineWriter(KindExec)
	_, _ = w.Write([]byte(strings.Repeat("x", maxPartialLine+1)))
	if buf.String() == "" {
		t.Error("a writer that never sees a newline must still flush")
	}
}

func TestBeatAndDiagCounters(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 200)
	c.Beat()
	c.CountDiag()
	c.CountDiag()
	st := c.Snapshot()
	if st.LastBeat.IsZero() {
		t.Error("Beat must record a keepalive")
	}
	if st.Diags != 2 {
		t.Errorf("Diags = %d, want 2", st.Diags)
	}
	if c.Mode().Sticky != true {
		t.Error("Mode must report the resolved mode")
	}
}

func TestUpdateIgnoresNil(_ *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 80)
	c.Update(nil) // must not panic
}

func TestStopClearsTheBarAndIsIdempotent(t *testing.T) {
	var buf syncBuffer
	c := stickyConsole(&buf, 80)
	c.Start()
	c.Line(KindOk, "connected")
	c.Stop()
	c.Stop()
	if !strings.HasSuffix(buf.String(), eraseLine) {
		t.Errorf("Stop must erase the bar, output ends %q", tail(buf.String(), 12))
	}
	// A line after Stop still prints, without resurrecting the bar.
	before := buf.String()
	c.Line(KindInfo, "session ended")
	after := strings.TrimPrefix(buf.String(), before)
	if !strings.Contains(after, "session ended") {
		t.Errorf("post-Stop line missing, got %q", after)
	}
	if strings.Contains(after, "● ") || strings.Contains(after, "◌ ") {
		t.Errorf("post-Stop output %q repainted a bar", after)
	}
}

func TestTickerRepaintsAndStopJoins(t *testing.T) {
	var buf syncBuffer
	c := New(&buf, Options{
		Mode:  Mode{Sticky: true, Unicode: true},
		Width: func() int { return 80 },
		Tick:  time.Millisecond,
	})
	c.Start()
	c.Start() // a second Start must not spawn a second ticker
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && strings.Count(buf.String(), eraseLine) < 3 {
		time.Sleep(5 * time.Millisecond)
	}
	c.Stop()
	painted := strings.Count(buf.String(), eraseLine)
	after := buf.String()
	time.Sleep(20 * time.Millisecond)
	if buf.String() != after {
		t.Error("Stop must join the ticker; output kept growing")
	}
	if painted < 3 {
		t.Errorf("ticker painted %d times, want at least 3", painted)
	}
}

func TestConcurrentLinesAndUpdates(t *testing.T) {
	var buf syncBuffer
	c := New(&buf, Options{
		Mode:  Mode{Sticky: true, Unicode: true, Color: true},
		Width: func() int { return 60 },
		Tick:  time.Millisecond,
	})
	c.Start()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				c.Line(KindExec, "exec: command %d-%d", n, j)
				c.CountDiag()
				c.Beat()
			}
		}(i)
	}
	wg.Wait()
	c.Stop()
	if got := c.Snapshot().Diags; got != 400 {
		t.Errorf("Diags = %d, want 400", got)
	}
}

// tail returns the last n bytes of s, for readable failure messages.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func TestConsoleColorsLinesWithoutTheBar(t *testing.T) {
	var buf strings.Builder
	// `watch` on a terminal: colors, but no sticky bar to fight the transcript.
	c := New(&buf, Options{Mode: Mode{Color: true}, Tag: "slicc watch"})
	c.Line(KindError, "boom")

	got := buf.String()
	if !strings.Contains(got, "slicc watch: boom") {
		t.Errorf("output %q lost the classic line form", got)
	}
	if !strings.Contains(got, "\x1b[") {
		t.Errorf("output %q was not colored", got)
	}
	if strings.Contains(got, eraseLine) {
		t.Errorf("output %q moved the cursor without a bar to maintain", got)
	}
}
