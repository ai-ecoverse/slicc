package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/execrun"
	"github.com/ai-ecoverse/slicc-cli/internal/follow"
	"github.com/ai-ecoverse/slicc-cli/internal/logging"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/tray"
	"github.com/ai-ecoverse/slicc-cli/internal/ui"
)

type inbound struct {
	typ string
	raw []byte
}

// cmdPrompt streams the leader's next assistant turn to stdout, then exits.
func cmdPrompt(ctx context.Context, joinURL, text string) int {
	done := make(chan int, 1)
	finish := func(code int) {
		select {
		case done <- code:
		default:
		}
	}
	// A live browser leader emits no `turn_end` — it signals turn completion via
	// scoopStatus going processing→ready. Track that transition; also honor a real
	// `turn_end` for non-live floats. (Handler runs single-threaded on the dispatch
	// goroutine, so `sawProcessing` needs no lock.)
	sawProcessing := false
	handler := func(typ string, raw []byte) {
		switch typ {
		case protocol.TypeAgentEvent:
			var env protocol.AgentEventEnvelope
			if json.Unmarshal(raw, &env) != nil {
				return
			}
			switch env.Event.Type {
			case protocol.AgentContentDelta:
				fmt.Print(env.Event.Text)
			case protocol.AgentTurnEnd:
				finish(0)
			case protocol.AgentError:
				errLineAfterStream("prompt", "%s", env.Event.Error)
				finish(1)
			}
		case protocol.TypeStatus:
			var s protocol.Status
			if json.Unmarshal(raw, &s) != nil {
				return
			}
			if s.ScoopStatus == protocol.ScoopStatusProcessing {
				sawProcessing = true
			} else if sawProcessing {
				finish(0) // processing → ready = turn complete
			}
		case protocol.TypeError:
			var e struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(raw, &e)
			errLineAfterStream("prompt", "%s", e.Error)
			finish(1)
		}
	}

	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf})
	if err != nil {
		errLine("prompt", "%s", err)
		reportRuntimeError("dial", err)
		return 1
	}
	defer conn.Close()

	if err := conn.SendJSON(protocol.UserMessage{
		Type: "user_message", Text: text, MessageID: newID(),
	}); err != nil {
		errLine("prompt", "%s", err)
		return 1
	}

	select {
	case code := <-done:
		fmt.Println()
		return code
	case <-conn.Done():
		errLineAfterStream("prompt", "connection closed before the turn completed")
		return 1
	case <-ctx.Done():
		// Tell the leader to stop the turn so it doesn't keep spending tokens.
		_ = conn.SendJSON(protocol.Abort{Type: "abort"})
		return 130
	}
}

// cmdExec runs a command in the leader's shell, streaming stdout/stderr, then exits.
func cmdExec(ctx context.Context, joinURL, command string) int {
	requestID := newID()
	done := make(chan int, 1)
	finish := func(code int) {
		select {
		case done <- code:
		default:
		}
	}
	handler := func(typ string, raw []byte) {
		switch typ {
		case protocol.TypeExecChunk:
			var ch protocol.ExecChunk
			if json.Unmarshal(raw, &ch) != nil || ch.RequestID != requestID {
				return
			}
			data, err := base64.StdEncoding.DecodeString(ch.Data)
			if err != nil {
				return
			}
			if ch.Stream == protocol.StreamStderr {
				os.Stderr.Write(data)
			} else {
				os.Stdout.Write(data)
			}
		case protocol.TypeExecResponse:
			var r protocol.ExecResponse
			if json.Unmarshal(raw, &r) != nil || r.RequestID != requestID {
				return
			}
			if r.Error != "" {
				errLine("exec", "%s", r.Error)
			}
			finish(r.ExitCode)
		}
	}

	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf})
	if err != nil {
		errLine("exec", "%s", err)
		reportRuntimeError("dial", err)
		return 1
	}
	defer conn.Close()

	if err := conn.SendJSON(protocol.ExecRequest{
		Type: "exec.request", RequestID: requestID, Command: command,
	}); err != nil {
		errLine("exec", "%s", err)
		return 1
	}

	select {
	case code := <-done:
		return code
	case <-conn.Done():
		errLine("exec", "connection closed")
		return 1
	case <-ctx.Done():
		// Ctrl+C: ask the leader to interrupt the command, then wait briefly.
		_ = conn.SendJSON(protocol.ExecSignal{Type: "exec.signal", RequestID: requestID, Signal: "SIGINT"})
		select {
		case code := <-done:
			return code
		case <-conn.Done():
			return 130
		case <-time.After(5 * time.Second):
			return 130
		}
	}
}

// cmdWatch connects as a passive follower and tails the leader's agent output
// for a scoop (default the cone) to stdout — content deltas as they stream, a
// blank line at each turn boundary — until interrupted. It sends nothing to the
// leader and never completes on its own: a read-only `tail -f` on what the agent
// is doing, reconnecting with backoff so it survives leader reloads.
func cmdWatch(ctx context.Context, joinURL, scoopJid string, plain bool) int {
	what := "the leader's agent output"
	if scoopJid != "" {
		what = fmt.Sprintf("scoop %q", scoopJid)
	}
	consoleMode, outMode := watchModes(outputMode(os.Stderr, plain), outputMode(os.Stdout, plain))
	r := watchRender{console: newConsole("slicc watch", consoleMode), out: outMode}
	r.console.Line(ui.KindInfo, "tailing %s (Ctrl+C to stop)", what)
	r.console.Start()
	defer printSessionSummary(r.console)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		r.console.Update(func(s *ui.Status) { s.State = ui.StateConnecting; s.Attempt = failures })
		clean, err := watchOnce(ctx, joinURL, scoopJid, r)
		if ctx.Err() != nil {
			return 0
		}
		if clean {
			failures = 0
			backoff = time.Second
		} else {
			failures++
			if err != nil {
				r.console.Line(ui.KindError, "%s", err)
				reportRuntimeError("watch", err)
			}
			if failures >= 20 {
				r.console.Line(ui.KindError, "giving up after 20 failed attempts")
				return 1
			}
		}
		r.console.Update(retrying(failures, backoff))
		r.console.Note(ui.KindInfo, "reconnecting in %s…", backoff)
		if !sleepCtx(ctx, backoff) {
			return 0
		}
		backoff = minDuration(backoff*2, 30*time.Second)
	}
}

// watchRender carries `watch`'s two output surfaces: the status console on
// stderr and the resolved styling for the agent stream on stdout.
type watchRender struct {
	console *ui.Console
	out     ui.Mode
}

func watchOnce(ctx context.Context, joinURL, scoopJid string, r watchRender) (clean bool, err error) {
	sawProcessing := false
	// Empty scoopJid = no filter (tail whatever the leader broadcasts).
	inScoop := func(js string) bool { return scoopJid == "" || js == scoopJid }
	handler := func(typ string, raw []byte) {
		switch typ {
		case protocol.TypeUserMessageEcho:
			// The human's prompt, echoed to followers — render it so the CLI
			// shows the same thread as the browser.
			var m protocol.UserMessageEcho
			if json.Unmarshal(raw, &m) == nil && inScoop(m.ScoopJid) {
				fmt.Printf("\n%s\n", r.out.Paint(ui.StyleBold, "> "+m.Text))
			}
		case protocol.TypeAgentEvent:
			var env protocol.AgentEventEnvelope
			if json.Unmarshal(raw, &env) == nil && inScoop(env.ScoopJid) {
				printWatchEvent(env.Event, r)
			}
		case protocol.TypeStatus:
			var s protocol.Status
			if json.Unmarshal(raw, &s) != nil {
				return
			}
			// Live browser floats emit no turn_end; a processing→ready flip is
			// the turn boundary, so separate turns with a newline there too.
			if s.ScoopStatus == protocol.ScoopStatusProcessing {
				sawProcessing = true
			} else if sawProcessing {
				sawProcessing = false
				fmt.Println()
			}
		}
	}
	conn, dialErr := tray.Dial(ctx, joinURL, tray.Options{
		OnMessage:  handler,
		OnActivity: r.console.Beat,
		OnLinkDiag: linkDiagCounter(r.console),
		Logf:       debugLogf,
	})
	if dialErr != nil {
		return false, dialErr
	}
	defer conn.Close()
	r.console.Update(markConnected)
	r.console.Line(ui.KindOk, "connected")
	select {
	case <-ctx.Done():
		return true, nil
	case <-conn.Done():
		r.console.Update(func(s *ui.Status) { s.State = ui.StateOffline })
		r.console.Line(ui.KindWarn, "connection closed")
		return true, nil
	}
}

// printWatchEvent renders one agent event the way the browser thread shows it:
// assistant text inline, tool calls + a short result on their own lines, errors
// through the status console. Unmodeled event types are silently skipped.
//
// The glyphs are literal rather than mode-dependent: the stream is a transcript
// other tools grep, so only color varies with the terminal.
func printWatchEvent(ev protocol.AgentEvent, r watchRender) {
	switch ev.Type {
	case protocol.AgentContentDelta:
		fmt.Print(ev.Text)
	case protocol.AgentToolUseStart:
		fmt.Printf("\n%s%s\n",
			r.out.Paint(ui.StyleBoldCyan, "⚙ "+ev.ToolName),
			r.out.Paint(ui.StyleDim, compactArgs(ev.ToolInput)))
	case protocol.AgentToolResult:
		mark, style := "↳", ui.StyleDim
		if ev.IsError != nil && *ev.IsError {
			mark, style = "↳ ✗", ui.StyleRed
		}
		fmt.Println(r.out.Paint(style, fmt.Sprintf("%s %s", mark, truncateOneLine(ev.Result, 200))))
	case protocol.AgentTurnEnd:
		fmt.Println()
	case protocol.AgentError:
		r.console.Line(ui.KindError, "%s", ev.Error)
	}
}

// compactArgs renders a tool's JSON input as a single truncated line for the
// `⚙ tool …` header ("" when absent or unparseable).
func compactArgs(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return ""
	}
	return " " + truncateOneLine(buf.String(), 160)
}

// truncateOneLine collapses whitespace runs to single spaces and caps the length
// at limit runes (so a multibyte char is never split), appending an ellipsis.
func truncateOneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + "…"
}

// cmdFollow stays connected and runs leader-issued commands locally through the
// given runner argv, reconnecting with backoff. An empty runner means the leader
// gets no exec on this box.
func cmdFollow(ctx context.Context, joinURL string, fa followArgs) int {
	// Eval mode: spawn the REPL ONCE, before connecting, so a missing binary
	// fails fast. The session outlives individual connections — REPL state
	// survives reconnects.
	var eval *execrun.EvalSession
	if fa.eval {
		if len(fa.runner) == 0 {
			errLine("follow --eval", "missing REPL runner (e.g. follow --eval python -i)")
			return 2
		}
		var err error
		eval, err = execrun.StartEval(execrun.EvalOptions{Runner: fa.runner, Quiet: fa.evalQuiet})
		if err != nil {
			errLine("follow --eval", "starting %s: %s", strings.Join(fa.runner, " "), err)
			return 1
		}
		defer eval.Close()
	}
	console := newConsole("slicc follow", outputMode(os.Stderr, fa.plain))
	printFollowBanner(console, fa)
	console.Update(func(s *ui.Status) { s.Peer = followPeer(console.Mode(), fa.runner) })
	console.Start()
	defer printSessionSummary(console)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		console.Update(func(s *ui.Status) { s.State = ui.StateConnecting; s.Attempt = failures })
		connected, err := followOnce(ctx, joinURL, fa.runner, eval, console)
		if ctx.Err() != nil {
			return 0
		}
		if connected {
			failures = 0
			backoff = time.Second
		} else {
			failures++
			if err != nil {
				console.Line(ui.KindError, "%s", err)
				reportRuntimeError("follow", err)
			}
			if failures >= 20 {
				console.Line(ui.KindError, "giving up after 20 failed attempts")
				return 1
			}
		}
		console.Update(retrying(failures, backoff))
		console.Note(ui.KindInfo, "reconnecting in %s…", backoff)
		if !sleepCtx(ctx, backoff) {
			return 0
		}
		backoff = minDuration(backoff*2, 30*time.Second)
	}
}

func followOnce(
	ctx context.Context,
	joinURL string,
	runner []string,
	eval *execrun.EvalSession,
	console *ui.Console,
) (connected bool, err error) {
	// Connection-scoped context: cancelled on ANY return (disconnect, ctx done),
	// so a leader-issued command that's still running is killed with the
	// connection instead of surviving on the follower's machine across reconnects.
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	msgCh := make(chan inbound, 256)

	var caps *protocol.Capabilities
	if len(runner) > 0 {
		caps = &protocol.Capabilities{Exec: true}
	}

	conn, dialErr := tray.Dial(connCtx, joinURL, tray.Options{
		Capabilities: caps,
		Motd:         followMotd(runner, eval != nil),
		Logf:         debugLogf,
		OnActivity:   console.Beat,
		OnLinkDiag:   linkDiagCounter(console),
		OnMessage: func(typ string, raw []byte) {
			select {
			case msgCh <- inbound{typ: typ, raw: raw}:
			default: // shed load rather than block the read goroutine
			}
		},
	})
	if dialErr != nil {
		return false, dialErr
	}
	defer conn.Close()
	execLog := console.LineWriter(ui.KindExec)
	var session *follow.Session
	if eval != nil {
		session = follow.NewEvalSession(conn, eval, execLog)
	} else {
		session = follow.NewSession(conn, runner, execLog)
	}
	console.Update(markConnected)
	console.Line(ui.KindOk, "connected")

	for {
		select {
		case <-ctx.Done():
			return true, nil
		case <-conn.Done():
			console.Update(func(s *ui.Status) { s.State = ui.StateOffline })
			console.Line(ui.KindWarn, "connection closed")
			return true, nil
		case m := <-msgCh:
			if m.typ == protocol.TypeExecRequest && caps != nil {
				console.Update(func(s *ui.Status) { s.Execs++ })
			}
			session.Handle(connCtx, m.typ, m.raw)
		}
	}
}

// --- presentation ------------------------------------------------------------

// newConsole builds the stderr status console for a long-running verb.
func newConsole(tag string, mode ui.Mode) *ui.Console {
	return ui.New(os.Stderr, ui.Options{
		Mode:  mode,
		Tag:   tag,
		Width: func() int { return ui.Width(os.Stderr, os.LookupEnv) },
	})
}

// watchModes resolves `watch`'s two surfaces. The status bar owns the last line
// of the terminal, which only works while nothing else writes there — and
// `watch` streams the agent transcript to stdout in partial lines (a
// content_delta rarely ends at a line boundary). So when stdout is a terminal
// too, the transcript wins: the console keeps its colors and drops the bar.
func watchModes(console, out ui.Mode) (ui.Mode, ui.Mode) {
	if out.Sticky {
		console.Sticky = false
	}
	return console, out
}

// outputMode resolves how much decoration f can take, with --plain as an
// override.
func outputMode(f *os.File, plain bool) ui.Mode {
	if plain {
		return ui.Mode{}
	}
	return stickyUnlessLogging(ui.Detect(f, os.LookupEnv), diagLogger)
}

// stickyUnlessLogging drops the bar while the diagnostic logger is emitting.
// diagLogger writes to stderr on its own — `tray` logs its retries and ICE
// transitions there — and the bar can only own the last row while nothing else
// writes to it. Turned up (SLICC_DEBUG=1, SLICC_LOG_LEVEL=…), a record would land
// on the bar's row and every later erase would target the wrong line. Debugging
// wants the full record stream anyway, so the records win and the bar steps
// aside; the status lines keep their colors.
func stickyUnlessLogging(mode ui.Mode, diag *logging.Logger) ui.Mode {
	if diag.Enabled() {
		mode.Sticky = false
	}
	return mode
}

// errLine writes a one-shot verb's fatal stderr line — red on an interactive
// terminal, and the same text as always when redirected. The one-shot verbs
// (`prompt`, `exec`) get no status bar: they are pipeline citizens whose stdout
// is the payload.
func errLine(verb, format string, args ...any) {
	mode := outputMode(os.Stderr, false)
	msg := fmt.Sprintf("slicc %s: %s", verb, fmt.Sprintf(format, args...))
	fmt.Fprintln(os.Stderr, mode.Paint(ui.StyleRed, msg))
}

// errLineAfterStream is errLine preceded by a blank line, for a failure that
// interrupts leader output already streaming on stdout.
func errLineAfterStream(verb, format string, args ...any) {
	fmt.Fprintln(os.Stderr)
	errLine(verb, format, args...)
}

// markConnected records a successful connection.
func markConnected(s *ui.Status) {
	s.State = ui.StateConnected
	s.Sessions++
	s.Attempt = 0
	s.RetryAt = time.Time{}
}

// retrying records the wait before the next attempt, which the status bar
// counts down.
func retrying(failures int, backoff time.Duration) func(*ui.Status) {
	retryAt := time.Now().Add(backoff)
	return func(s *ui.Status) {
		s.State = ui.StateRetrying
		s.RetryAt = retryAt
		s.Attempt = failures
	}
}

// linkDiagCounter tallies pion's own warnings and errors in the status bar.
// They are the ICE/TURN churn that used to scroll past as `turnc ERROR: Fail to
// refresh permissions` walls: worth a count, not worth a line each. The records
// themselves stay available through SLICC_DEBUG=1.
func linkDiagCounter(console *ui.Console) logging.PionEvent {
	return func(_ string, level slog.Level, _ string) {
		if level >= slog.LevelWarn {
			console.CountDiag()
		}
	}
}

// printSessionSummary tears the status bar down and, for a session that reached
// the leader at least once, replaces it with one closing line — the numbers the
// bar was showing, kept in the scrollback.
func printSessionSummary(console *ui.Console) {
	console.Stop()
	st := console.Snapshot()
	if st.Sessions == 0 {
		return
	}
	console.Line(ui.KindInfo, "session ended after %s — %s, %s, %s",
		ui.CompactDuration(time.Since(st.Started)),
		plural(st.Execs, "exec"),
		plural(st.Sessions-1, "reconnect"),
		plural(st.Diags, "link diagnostic"))
}

// followPeer is the status bar's "who and how" field: the identity a leader
// command would run as, plus the runner it goes through.
//
// The host is shortened to its first label — the bar competes for one line, and
// "laptop" says the same thing there as "laptop.local". The banner and the MOTD
// keep the full name; those are the identity record.
func followPeer(mode ui.Mode, runner []string) string {
	who := fmt.Sprintf("%s@%s", currentUser(), shortHost(hostname()))
	if len(runner) == 0 {
		return who + " (no exec)"
	}
	return fmt.Sprintf("%s %s %s", who, mode.Glyph(ui.GlyphSeparator), strings.Join(runner, " "))
}

func shortHost(host string) string {
	if i := strings.IndexByte(host, '.'); i > 0 {
		return host[:i]
	}
	return host
}

func plural(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// --- helpers -----------------------------------------------------------------

// followArt is the small ASCII wordmark printed at `follow` startup (suppress
// with --no-banner). It greets the human at the terminal; the machine-facing
// summary the connecting agent sees travels over the wire as followMotd.
const followArt = `   _____ _ _
  / ____| (_)
 | (___ | |_  ___ ___
  \___ \| | |/ __/ __|
  ____) | | | (_| (__
 |_____/|_|_|\___\___|   follow
`

// printFollowBanner writes the startup banner: the ASCII wordmark (unless
// suppressed), who the leader would run as, the runner, and — when the runner
// looks like it won't actually execute commands — a heuristic warning.
//
// The banner is written with Console.Raw, so its wording and layout are
// byte-identical whether or not a terminal is attached: only the color changes.
// A safety warning is not a place to vary text by output stream.
func printFollowBanner(console *ui.Console, fa followArgs) {
	if fa.showBanner {
		console.Raw(ui.StyleBoldCyan, followArt)
	}
	who := fmt.Sprintf("%s@%s", currentUser(), hostname())
	if len(fa.runner) == 0 {
		console.Line(ui.KindInfo, "connecting as %s (exec disabled — no runner given)", who)
		return
	}
	console.Raw(ui.StyleBoldRed, fmt.Sprintf("⚠  the leader can run commands on this machine as %s", who))
	if fa.eval {
		console.Raw(ui.StyleDim, fmt.Sprintf(
			"   REPL/eval mode: one persistent `%s` process; each command is a line on its stdin",
			strings.Join(fa.runner, " ")))
		console.Raw(ui.StyleDim, "   (a response ends once the REPL goes quiet; state persists across commands)")
		if warn := evalRunnerWarning(fa.runner); warn != "" {
			console.Raw(ui.StyleYellow, "⚠  "+warn)
		}
		return
	}
	console.Raw(ui.StyleDim, fmt.Sprintf(
		"   via: %s <command>   (each command is printed here as it runs)", strings.Join(fa.runner, " ")))
	if warn := runnerExecWarning(fa.runner); warn != "" {
		console.Raw(ui.StyleYellow, "⚠  "+warn)
	}
}

// evalRunnerWarning flags REPLs that are known to buffer piped stdin instead
// of evaluating per line — the eval-mode counterpart of the `follow bash`
// footgun. node reads the WHOLE pipe before running unless forced interactive.
func evalRunnerWarning(runner []string) string {
	base := shellBase(runner[0])
	if base != "node" {
		return ""
	}
	for _, tok := range runner[1:] {
		if tok == "-i" || tok == "--interactive" {
			return ""
		}
	}
	return "node buffers piped stdin until EOF — you probably want: follow --eval node -i"
}

// followMotd is the concise, one-line description the follower advertises in its
// hello handshake. The leader surfaces it to the agent (via `ssh --list`) so the
// first `ssh` reveals what the target is, who it runs as, and its platform.
// Empty for a no-runner follower (nothing is exec-capable to describe).
func followMotd(runner []string, eval bool) string {
	if len(runner) == 0 {
		return ""
	}
	if eval {
		return fmt.Sprintf("slicc-cli REPL target · %s@%s · %s/%s · persistent `%s` session: send %s code, not shell commands; state persists across commands",
			currentUser(), hostname(), runtime.GOOS, runtime.GOARCH, strings.Join(runner, " "), shellBase(runner[0]))
	}
	return fmt.Sprintf("slicc-cli exec target · %s@%s · %s/%s · runner: %s · runs as this user (RCE by design)",
		currentUser(), hostname(), runtime.GOOS, runtime.GOARCH, strings.Join(runner, " "))
}

// knownShells are interactive/POSIX shells that need a `-c` argument to run a
// command LINE; without it they treat the argument as a script FILE path.
var knownShells = map[string]bool{
	"bash": true, "sh": true, "zsh": true, "dash": true,
	"ksh": true, "ash": true, "fish": true, "elvish": true,
}

// wrapperTools launch another program; the leader's command becomes argv to
// them, so unless they end in a shell `-c` the command isn't a shell line.
var wrapperTools = map[string]bool{
	"docker": true, "podman": true, "nerdctl": true, "container": true,
	"kubectl": true, "lxc": true, "lxc-attach": true, "flatpak-spawn": true, "ssh": true,
}

// runnerExecWarning returns a non-empty warning when the runner very likely
// won't run the leader's command as a shell command line — the classic
// `follow bash` footgun (bare `bash <arg>` execs <arg> as a script file, so
// `ls` → "cannot execute binary file", `echo hi` → "No such file or directory").
func runnerExecWarning(runner []string) string {
	if len(runner) == 0 {
		return ""
	}
	joined := strings.Join(runner, " ")
	// A shell must be followed by -c to run a command line, not a script file.
	// Use the LAST shell token so `docker exec … sh -c` is judged on its `sh`.
	lastShell := -1
	for i, tok := range runner {
		if knownShells[shellBase(tok)] {
			lastShell = i
		}
	}
	if lastShell >= 0 {
		for _, tok := range runner[lastShell+1:] {
			if tok == "-c" {
				return "" // e.g. `bash -c`, `docker exec -i box sh -c`
			}
		}
		base := shellBase(runner[lastShell])
		return fmt.Sprintf(
			"runner %q has no -c: %s treats the leader's command as a script FILE, not a command line — you probably want: %s -c",
			joined, base, base)
	}
	if wrapperTools[shellBase(runner[0])] {
		return fmt.Sprintf(
			"runner %q ends without a shell -c: the leader's command is passed as arguments to %s, not a shell line — end it with e.g. `sh -c` if you want shell command lines",
			joined, shellBase(runner[0]))
	}
	return ""
}

// shellBase reduces a runner token to its command name (drops any directory and
// a trailing .exe) so `/bin/bash` and `bash.exe` both match `bash`.
func shellBase(tok string) string {
	b := tok
	if i := strings.LastIndexAny(b, `/\`); i >= 0 {
		b = b[i+1:]
	}
	return strings.TrimSuffix(b, ".exe")
}

func currentUser() string {
	for _, k := range []string{"USER", "USERNAME", "LOGNAME"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return "unknown"
}

func hostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "localhost"
}

// diagLogger is the process-wide diagnostic logger. Diagnostics go to stderr so
// they never interleave with the leader output that `prompt`/`exec`/`watch`
// stream to stdout.
var diagLogger = logging.NewFromEnv(os.Stderr)

// debugLogf is the `func(format string, args ...any)` seam consumed by
// tray.Options.Logf; it forwards into the structured logger.
func debugLogf(format string, args ...any) {
	diagLogger.Logf(format, args...)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
