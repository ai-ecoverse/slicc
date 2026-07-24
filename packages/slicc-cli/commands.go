package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
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

// cmdFollow stays connected and runs leader-issued commands locally, reconnecting
// with backoff. Unless --deny-exec is set, the leader gets a shell on this box.
func cmdFollow(ctx context.Context, joinURL string, denyExec bool) int {
	printFollowBanner(denyExec)
	backoff := time.Second
	failures := 0
	for {
		if ctx.Err() != nil {
			return 0
		}
		connected, err := followOnce(ctx, joinURL, denyExec)
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

func followOnce(ctx context.Context, joinURL string, denyExec bool) (connected bool, err error) {
	msgCh := make(chan inbound, 256)

	var caps *protocol.Capabilities
	if !denyExec {
		caps = &protocol.Capabilities{Exec: true}
	}

	conn, dialErr := tray.Dial(ctx, joinURL, tray.Options{
		Capabilities: caps,
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
	session := follow.NewSession(conn, denyExec, os.Stderr)
	fmt.Fprintln(os.Stderr, "slicc follow: connected")

	for {
		select {
		case <-ctx.Done():
			return true, nil
		case <-conn.Done():
			fmt.Fprintln(os.Stderr, "slicc follow: connection closed")
			return true, nil
		case m := <-msgCh:
			session.Handle(ctx, m.typ, m.raw)
		}
	}
}

// --- helpers -----------------------------------------------------------------

func printFollowBanner(denyExec bool) {
	who := fmt.Sprintf("%s@%s", currentUser(), hostname())
	if denyExec {
		fmt.Fprintf(os.Stderr, "slicc follow: connecting as %s (exec DISABLED via --deny-exec)\n", who)
		return
	}
	fmt.Fprintf(os.Stderr, "⚠️  slicc follow: the leader can run shell commands on this machine as %s.\n", who)
	fmt.Fprintln(os.Stderr, "    Each command is printed here as it runs. Pass --deny-exec to refuse.")
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
