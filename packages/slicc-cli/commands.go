package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/follow"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/tray"
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
				fmt.Fprintf(os.Stderr, "\nslicc prompt: %s\n", env.Event.Error)
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
			fmt.Fprintf(os.Stderr, "\nslicc prompt: %s\n", e.Error)
			finish(1)
		}
	}

	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf})
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc prompt: %s\n", err)
		return 1
	}
	defer conn.Close()

	if err := conn.SendJSON(protocol.UserMessage{
		Type: "user_message", Text: text, MessageID: newID(),
	}); err != nil {
		fmt.Fprintf(os.Stderr, "slicc prompt: %s\n", err)
		return 1
	}

	select {
	case code := <-done:
		fmt.Println()
		return code
	case <-conn.Done():
		fmt.Fprintln(os.Stderr, "\nslicc prompt: connection closed before the turn completed")
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
				fmt.Fprintf(os.Stderr, "slicc exec: %s\n", r.Error)
			}
			finish(r.ExitCode)
		}
	}

	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf})
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc exec: %s\n", err)
		return 1
	}
	defer conn.Close()

	if err := conn.SendJSON(protocol.ExecRequest{
		Type: "exec.request", RequestID: requestID, Command: command,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "slicc exec: %s\n", err)
		return 1
	}

	select {
	case code := <-done:
		return code
	case <-conn.Done():
		fmt.Fprintln(os.Stderr, "slicc exec: connection closed")
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
func cmdWatch(ctx context.Context, joinURL, scoopJid string) int {
	what := "the leader's agent output"
	if scoopJid != "" {
		what = fmt.Sprintf("scoop %q", scoopJid)
	}
	fmt.Fprintf(os.Stderr, "slicc watch: tailing %s (Ctrl+C to stop)\n", what)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		clean, err := watchOnce(ctx, joinURL, scoopJid)
		if ctx.Err() != nil {
			return 0
		}
		if clean {
			failures = 0
			backoff = time.Second
		} else {
			failures++
			if err != nil {
				fmt.Fprintf(os.Stderr, "slicc watch: %s\n", err)
			}
			if failures >= 20 {
				fmt.Fprintln(os.Stderr, "slicc watch: giving up after 20 failed attempts")
				return 1
			}
		}
		fmt.Fprintf(os.Stderr, "slicc watch: reconnecting in %s…\n", backoff)
		if !sleepCtx(ctx, backoff) {
			return 0
		}
		backoff = minDuration(backoff*2, 30*time.Second)
	}
}

func watchOnce(ctx context.Context, joinURL, scoopJid string) (clean bool, err error) {
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
				fmt.Printf("\n> %s\n", m.Text)
			}
		case protocol.TypeAgentEvent:
			var env protocol.AgentEventEnvelope
			if json.Unmarshal(raw, &env) == nil && inScoop(env.ScoopJid) {
				printWatchEvent(env.Event)
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
	conn, dialErr := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf})
	if dialErr != nil {
		return false, dialErr
	}
	defer conn.Close()
	fmt.Fprintln(os.Stderr, "slicc watch: connected")
	select {
	case <-ctx.Done():
		return true, nil
	case <-conn.Done():
		fmt.Fprintln(os.Stderr, "slicc watch: connection closed")
		return true, nil
	}
}

// printWatchEvent renders one agent event the way the browser thread shows it:
// assistant text inline, tool calls + a short result on their own lines, errors
// on stderr. Unmodeled event types are silently skipped.
func printWatchEvent(ev protocol.AgentEvent) {
	switch ev.Type {
	case protocol.AgentContentDelta:
		fmt.Print(ev.Text)
	case protocol.AgentToolUseStart:
		fmt.Printf("\n⚙ %s%s\n", ev.ToolName, compactArgs(ev.ToolInput))
	case protocol.AgentToolResult:
		mark := "↳"
		if ev.IsError != nil && *ev.IsError {
			mark = "↳ ✗"
		}
		fmt.Printf("%s %s\n", mark, truncateOneLine(ev.Result, 200))
	case protocol.AgentTurnEnd:
		fmt.Println()
	case protocol.AgentError:
		fmt.Fprintf(os.Stderr, "\nslicc watch: %s\n", ev.Error)
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
func cmdFollow(ctx context.Context, joinURL string, runner []string, showBanner bool) int {
	printFollowBanner(os.Stderr, runner, showBanner)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		connected, err := followOnce(ctx, joinURL, runner)
		if ctx.Err() != nil {
			return 0
		}
		if connected {
			failures = 0
			backoff = time.Second
		} else {
			failures++
			if err != nil {
				fmt.Fprintf(os.Stderr, "slicc follow: %s\n", err)
			}
			if failures >= 20 {
				fmt.Fprintln(os.Stderr, "slicc follow: giving up after 20 failed attempts")
				return 1
			}
		}
		fmt.Fprintf(os.Stderr, "slicc follow: reconnecting in %s…\n", backoff)
		if !sleepCtx(ctx, backoff) {
			return 0
		}
		backoff = minDuration(backoff*2, 30*time.Second)
	}
}

func followOnce(ctx context.Context, joinURL string, runner []string) (connected bool, err error) {
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
		Motd:         followMotd(runner),
		Logf:         debugLogf,
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
	session := follow.NewSession(conn, runner, os.Stderr)
	fmt.Fprintln(os.Stderr, "slicc follow: connected")

	for {
		select {
		case <-ctx.Done():
			return true, nil
		case <-conn.Done():
			fmt.Fprintln(os.Stderr, "slicc follow: connection closed")
			return true, nil
		case m := <-msgCh:
			session.Handle(connCtx, m.typ, m.raw)
		}
	}
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
func printFollowBanner(w io.Writer, runner []string, showArt bool) {
	if showArt {
		fmt.Fprint(w, followArt)
	}
	who := fmt.Sprintf("%s@%s", currentUser(), hostname())
	if len(runner) == 0 {
		fmt.Fprintf(w, "slicc follow: connecting as %s (exec disabled — no runner given)\n", who)
		return
	}
	fmt.Fprintf(w, "⚠  the leader can run commands on this machine as %s\n", who)
	fmt.Fprintf(w, "   via: %s <command>   (each command is printed here as it runs)\n", strings.Join(runner, " "))
	if warn := runnerExecWarning(runner); warn != "" {
		fmt.Fprintf(w, "⚠  %s\n", warn)
	}
}

// followMotd is the concise, one-line description the follower advertises in its
// hello handshake. The leader surfaces it to the agent (via `ssh --list`) so the
// first `ssh` reveals what the target is, who it runs as, and its platform.
// Empty for a no-runner follower (nothing is exec-capable to describe).
func followMotd(runner []string) string {
	if len(runner) == 0 {
		return ""
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

func debugLogf(format string, args ...any) {
	if os.Getenv("SLICC_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "[slicc] "+format+"\n", args...)
	}
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
