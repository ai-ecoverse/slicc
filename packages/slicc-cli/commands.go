package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
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


func cmdPrompt(ctx context.Context, joinURL, text string) int {
	done := make(chan int, 1)
	finish := func(code int) {
		select {
		case done <- code:
		default:
		}
	}
	
	
	
	
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
				finish(0) 
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

	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf, LogWanted: diagLogger.EnabledAt})
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
		
		_ = conn.SendJSON(protocol.Abort{Type: "abort"})
		return 130
	}
}




func readPipedStdinBase64(r io.Reader) (string, error) {
	if f, ok := r.(*os.File); ok {
		st, err := f.Stat()
		if err != nil {
			return "", err
		}
		if st.Mode()&os.ModeCharDevice != 0 {
			return "", nil
		}
	}
	b, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	if len(b) == 0 {
		return "", nil
	}
	return base64.StdEncoding.EncodeToString(b), nil
}


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

	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf, LogWanted: diagLogger.EnabledAt})
	if err != nil {
		errLine("exec", "%s", err)
		reportRuntimeError("dial", err)
		return 1
	}
	defer conn.Close()

	req := protocol.ExecRequest{
		Type: "exec.request", RequestID: requestID, Command: command,
	}
	if stdin, err := readPipedStdinBase64(os.Stdin); err != nil {
		errLine("exec", "reading stdin: %s", err)
		return 1
	} else if stdin != "" {
		req.Stdin = stdin
	}
	if err := conn.SendJSON(req); err != nil {
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
	join := newJoinURLState(joinURL)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		join.beginAttempt()
		r.console.Update(func(s *ui.Status) { s.State = ui.StateConnecting; s.Attempt = failures })
		clean, err := watchOnce(ctx, join.current(), scoopJid, r, join.onTrayJoinURLChanged)
		if ctx.Err() != nil {
			return 0
		}
		if clean {
			failures = 0
			backoff = time.Second
		} else {
			var resetBackoff bool
			failures, resetBackoff = join.recordReconnectFailure(failures, err)
			if resetBackoff {
				backoff = time.Second
			}
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



type watchRender struct {
	console *ui.Console
	out     ui.Mode
}

func watchOnce(
	ctx context.Context,
	joinURL, scoopJid string,
	r watchRender,
	onJoinURLChanged func(string),
) (clean bool, err error) {
	sawProcessing := false
	
	inScoop := func(js string) bool { return scoopJid == "" || js == scoopJid }
	handler := func(typ string, raw []byte) {
		switch typ {
		case protocol.TypeUserMessageEcho:
			
			
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
			
			
			if s.ScoopStatus == protocol.ScoopStatusProcessing {
				sawProcessing = true
			} else if sawProcessing {
				sawProcessing = false
				fmt.Println()
			}
		}
	}
	conn, dialErr := tray.Dial(ctx, joinURL, tray.Options{
		OnMessage:        handler,
		OnActivity:       r.console.Beat,
		OnLinkDiag:       linkDiagCounter(r.console),
		OnJoinURLChanged: onJoinURLChanged,
		Logf:             debugLogf,
		LogWanted:        diagLogger.EnabledAt,
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



func truncateOneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit]) + "…"
}




func cmdFollow(ctx context.Context, joinURL string, fa followArgs) int {
	
	
	
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
	join := newJoinURLState(joinURL)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		join.beginAttempt()
		console.Update(func(s *ui.Status) { s.State = ui.StateConnecting; s.Attempt = failures })
		connected, err := followOnce(ctx, join.current(), fa.runner, eval, console, join.onTrayJoinURLChanged)
		if ctx.Err() != nil {
			return 0
		}
		if connected {
			failures = 0
			backoff = time.Second
		} else {
			var resetBackoff bool
			failures, resetBackoff = join.recordReconnectFailure(failures, err)
			if resetBackoff {
				backoff = time.Second
			}
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
	onJoinURLChanged func(string),
) (connected bool, err error) {
	
	
	
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	msgCh := make(chan inbound, 256)

	var caps *protocol.Capabilities
	if len(runner) > 0 {
		caps = &protocol.Capabilities{Exec: true}
	}

	conn, dialErr := tray.Dial(connCtx, joinURL, tray.Options{
		Capabilities:     caps,
		Motd:             followMotd(runner, eval != nil),
		Logf:             debugLogf,
		LogWanted:        diagLogger.EnabledAt,
		OnActivity:       console.Beat,
		OnLinkDiag:       linkDiagCounter(console),
		OnJoinURLChanged: onJoinURLChanged,
		OnMessage: func(typ string, raw []byte) {
			select {
			case msgCh <- inbound{typ: typ, raw: raw}:
			default: 
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




func newConsole(tag string, mode ui.Mode) *ui.Console {
	return ui.New(os.Stderr, ui.Options{
		Mode:  mode,
		Tag:   tag,
		Width: func() int { return ui.Width(os.Stderr, os.LookupEnv) },
	})
}






func watchModes(console, out ui.Mode) (ui.Mode, ui.Mode) {
	if out.Sticky {
		console.Sticky = false
	}
	return console, out
}



func outputMode(f *os.File, plain bool) ui.Mode {
	if plain {
		return ui.Mode{}
	}
	return stickyUnlessLogging(ui.Detect(f, os.LookupEnv), diagLogger)
}








func stickyUnlessLogging(mode ui.Mode, diag *logging.Logger) ui.Mode {
	if diag.Enabled() {
		mode.Sticky = false
	}
	return mode
}





func errLine(verb, format string, args ...any) {
	mode := outputMode(os.Stderr, false)
	msg := fmt.Sprintf("slicc %s: %s", verb, fmt.Sprintf(format, args...))
	fmt.Fprintln(os.Stderr, mode.Paint(ui.StyleRed, msg))
}



func errLineAfterStream(verb, format string, args ...any) {
	fmt.Fprintln(os.Stderr)
	errLine(verb, format, args...)
}


func markConnected(s *ui.Status) {
	s.State = ui.StateConnected
	s.Sessions++
	s.Attempt = 0
	s.RetryAt = time.Time{}
}



func retrying(failures int, backoff time.Duration) func(*ui.Status) {
	retryAt := time.Now().Add(backoff)
	return func(s *ui.Status) {
		s.State = ui.StateRetrying
		s.RetryAt = retryAt
		s.Attempt = failures
	}
}





func linkDiagCounter(console *ui.Console) logging.PionEvent {
	return func(_ string, level slog.Level, _ string) {
		if level >= slog.LevelWarn {
			console.CountDiag()
		}
	}
}




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






const followArt = `   _____ _ _
  / ____| (_)
 | (___ | |_  ___ ___
  \___ \| | |/ __/ __|
  ____) | | | (_| (__
 |_____/|_|_|\___\___|   follow
`








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



var knownShells = map[string]bool{
	"bash": true, "sh": true, "zsh": true, "dash": true,
	"ksh": true, "ash": true, "fish": true, "elvish": true,
}



var wrapperTools = map[string]bool{
	"docker": true, "podman": true, "nerdctl": true, "container": true,
	"kubectl": true, "lxc": true, "lxc-attach": true, "flatpak-spawn": true, "ssh": true,
}





func runnerExecWarning(runner []string) string {
	if len(runner) == 0 {
		return ""
	}
	joined := strings.Join(runner, " ")
	
	
	lastShell := -1
	for i, tok := range runner {
		if knownShells[shellBase(tok)] {
			lastShell = i
		}
	}
	if lastShell >= 0 {
		for _, tok := range runner[lastShell+1:] {
			if tok == "-c" {
				return "" 
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




var diagLogger = logging.NewFromEnv(os.Stderr)



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
