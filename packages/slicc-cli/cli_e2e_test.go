package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)

// End-to-end tests that build the real `slicc` binary and drive each verb as a
// subprocess against a pion leader (leader_harness_test.go) over real loopback
// WebRTC — the CI-runnable distillation of the manual browser smoke test. Both
// exec directions and the live-float `prompt` completion path are covered.

var (
	binOnce sync.Once
	binPath string
	binErr  error
)

// sliccBinary builds the CLI once and returns its path.
func sliccBinary(t *testing.T) string {
	t.Helper()
	binOnce.Do(func() {
		dir, err := os.MkdirTemp("", "slicc-e2e")
		if err != nil {
			binErr = err
			return
		}
		binPath = filepath.Join(dir, "slicc")
		if runtime.GOOS == "windows" {
			binPath += ".exe"
		}
		out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput()
		if err != nil {
			binErr = fmt.Errorf("go build: %w\n%s", err, out)
		}
	})
	if binErr != nil {
		t.Fatalf("build slicc: %v", binErr)
	}
	return binPath
}

// TestCLIFollowRunsLeaderCommand: `slicc <url> follow <runner>` — the leader
// issues an exec.request and the follower runs it on the real OS and streams it
// back (the `ssh` direction the browser smoke test validated). The runner is the
// platform shell (`sh -c` / `cmd /c`) so this runs on every OS in the matrix.
func TestCLIFollowRunsLeaderCommand(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)

	const nonce = "SSH-E2E-OK-4242"
	var mu sync.Mutex
	var got strings.Builder
	done := make(chan int, 1)

	leader.dc.OnOpen(func() {
		_ = sendJSON(leader.dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
		_ = sendJSON(leader.dc, protocol.ExecRequest{
			Type: protocol.TypeExecRequest, RequestID: "ssh-1", Command: "echo " + nonce,
		})
	})
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil {
			return
		}
		switch env.Type {
		case protocol.TypeExecChunk:
			var ch protocol.ExecChunk
			if json.Unmarshal(msg.Data, &ch) != nil || ch.RequestID != "ssh-1" || ch.Stream != protocol.StreamStdout {
				return
			}
			b, _ := base64.StdEncoding.DecodeString(ch.Data)
			mu.Lock()
			got.Write(b)
			mu.Unlock()
		case protocol.TypeExecResponse:
			var r protocol.ExecResponse
			if json.Unmarshal(msg.Data, &r) == nil && r.RequestID == "ssh-1" {
				select {
				case done <- r.ExitCode:
				default:
				}
			}
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	followArgs := append([]string{leader.joinURL, "follow"}, testRunner()...)
	cmd := exec.CommandContext(ctx, bin, followArgs...)
	cmd.Env = append(os.Environ(), "SLICC_DEBUG=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start follower: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("leader exec exit=%d; follower stderr:\n%s", code, stderr.String())
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for exec.response; follower stderr:\n%s", stderr.String())
	}
	mu.Lock()
	out := got.String()
	mu.Unlock()
	if !strings.Contains(out, nonce) {
		t.Fatalf("leader received %q, want it to contain %q", out, nonce)
	}
}

// TestCLIExecRunsOnLeader: `slicc <url> exec "…"` — the follower asks the leader
// to run a command; the leader (a real shell here, standing in for the browser's
// virtual shell) runs it and streams output the CLI prints to stdout.
func TestCLIExecRunsOnLeader(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)

	leader.dc.OnOpen(func() {
		_ = sendJSON(leader.dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
	})
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil || env.Type != protocol.TypeExecRequest {
			return
		}
		var req protocol.ExecRequest
		if json.Unmarshal(msg.Data, &req) != nil {
			return
		}
		go func() {
			runner := append(testRunner(), req.Command)
			out, _ := exec.Command(runner[0], runner[1:]...).CombinedOutput()
			_ = sendJSON(leader.dc, protocol.ExecChunk{
				Type: protocol.TypeExecChunk, RequestID: req.RequestID,
				Stream: protocol.StreamStdout, Data: base64.StdEncoding.EncodeToString(out),
			})
			_ = sendJSON(leader.dc, protocol.ExecResponse{
				Type: protocol.TypeExecResponse, RequestID: req.RequestID, ExitCode: 0,
			})
		}()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, leader.joinURL, "exec", "echo EXEC-E2E-OK")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("exec CLI: %v; stderr:\n%s", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "EXEC-E2E-OK") {
		t.Fatalf("exec stdout = %q, want to contain EXEC-E2E-OK; stderr:\n%s", stdout.String(), stderr.String())
	}
}

// TestCLIWatchStreamsConeOutput: `slicc <url> watch` — a passive tail that
// mirrors the browser thread. The CLI sends nothing; the leader broadcasts the
// user's prompt (user_message_echo), assistant text (content_delta), and a tool
// call (tool_use_start), all of which must reach stdout. The scoop jid is a
// generated uid (NOT the literal "cone"), so this also guards the default-filter
// regression. `watch` never exits on its own, so we read until every marker
// appears and then kill the long-lived watcher.
func TestCLIWatchStreamsConeOutput(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)

	const (
		jid        = "cone-7f3a2b91"
		userMarker = "USER-PROMPT-E2E"
		asstMarker = "ASSISTANT-E2E"
		toolMarker = "bash-e2e-tool"
	)
	leader.dc.OnOpen(func() {
		_ = sendJSON(leader.dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
		_ = sendJSON(leader.dc, protocol.UserMessageEcho{
			Type: protocol.TypeUserMessageEcho, ScoopJid: jid, MessageID: "u1", Text: userMarker,
		})
		_ = sendJSON(leader.dc, protocol.AgentEventEnvelope{
			Type: protocol.TypeAgentEvent, ScoopJid: jid,
			Event: protocol.AgentEvent{Type: protocol.AgentContentDelta, MessageID: "m1", Text: asstMarker},
		})
		_ = sendJSON(leader.dc, protocol.AgentEventEnvelope{
			Type: protocol.TypeAgentEvent, ScoopJid: jid,
			Event: protocol.AgentEvent{
				Type: protocol.AgentToolUseStart, MessageID: "m1",
				ToolName: toolMarker, ToolInput: json.RawMessage(`{"command":"ls"}`),
			},
		})
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, leader.joinURL, "watch")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start watch: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	got := make(chan string, 1)
	go func() {
		var buf []byte
		tmp := make([]byte, 256)
		for {
			n, rerr := stdout.Read(tmp)
			if n > 0 {
				buf = append(buf, tmp[:n]...)
				s := string(buf)
				if strings.Contains(s, userMarker) && strings.Contains(s, asstMarker) &&
					strings.Contains(s, toolMarker) {
					got <- s
					return
				}
			}
			if rerr != nil {
				got <- string(buf)
				return
			}
		}
	}()

	select {
	case out := <-got:
		for _, want := range []string{"> " + userMarker, asstMarker, "⚙ " + toolMarker} {
			if !strings.Contains(out, want) {
				t.Fatalf("watch stdout = %q, missing %q; stderr:\n%s", out, want, stderr.String())
			}
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for watch output; stderr:\n%s", stderr.String())
	}
}

// TestCLIPromptCompletesOnLiveFloat: `slicc <url> prompt "…"` against a leader
// that emits the LIVE browser-float sequence — content deltas + a
// processing→ready status, and NO `turn_end`. The CLI must print the delta and
// EXIT on the ready transition (regression for the "prompt hangs" P1 fix); if it
// waited for turn_end it would block until the context times out.
func TestCLIPromptCompletesOnLiveFloat(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)

	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil || env.Type != "user_message" {
			return
		}
		go func() {
			_ = sendJSON(leader.dc, protocol.Status{Type: protocol.TypeStatus, ScoopStatus: "processing"})
			_ = sendJSON(leader.dc, protocol.AgentEventEnvelope{
				Type:  protocol.TypeAgentEvent,
				Event: protocol.AgentEvent{Type: protocol.AgentContentDelta, MessageID: "m1", Text: "PROMPT-E2E-OK"},
			})
			_ = sendJSON(leader.dc, protocol.Status{Type: protocol.TypeStatus, ScoopStatus: "ready"})
		}()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, leader.joinURL, "prompt", "hi there")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "PROMPT-E2E-OK") {
		t.Fatalf("prompt stdout = %q, want to contain PROMPT-E2E-OK", stdout.String())
	}
}

// holdPrompt starts `prompt` against a leader that stays in `processing` until
// it sees `abort`. `ackAfter` > 0 makes the leader confirm that late; 0 never
// confirms. `started` is when the prompt is on the wire. `ackAt` is when the
// ack was sent, zero when none was.
func holdPrompt(t *testing.T, confirm string, ackAfter time.Duration) (cmd *exec.Cmd, stderr *bytes.Buffer, acked <-chan time.Time) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("SIGINT delivery is not the Unix path under test")
	}
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)
	started := make(chan struct{})
	var once sync.Once
	ackCh := make(chan time.Time, 1)
	acked = ackCh
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil {
			return
		}
		switch env.Type {
		case "user_message":
			_ = sendJSON(leader.dc, protocol.Status{Type: protocol.TypeStatus, ScoopStatus: "processing"})
			_ = sendJSON(leader.dc, protocol.AgentEventEnvelope{
				Type: protocol.TypeAgentEvent,
				Event: protocol.AgentEvent{
					Type: protocol.AgentContentDelta, MessageID: "m1", Text: "HOLD",
				},
			})
			once.Do(func() { close(started) })
		case "abort":
			if ackAfter <= 0 {
				return
			}
			time.Sleep(ackAfter)
			ackCh <- time.Now()
			_ = sendJSON(leader.dc, protocol.AbortAck{
				Type: protocol.TypeAbortAck, ScoopJid: "cone", Stopped: []string{"cone"},
			})
		}
	})
	cmd = exec.Command(bin, leader.joinURL, "prompt", "hi there")
	cmd.Env = append(os.Environ(), "SLICC_ABORT_CONFIRM="+confirm, "SLICC_PROMPT_SETTLE=30s")
	stderr = &bytes.Buffer{}
	cmd.Stdout = &bytes.Buffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start prompt: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	select {
	case <-started:
	case <-time.After(20 * time.Second):
		t.Fatal("prompt never reached the leader")
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatalf("signal: %v", err)
	}
	return cmd, stderr, acked
}

func waitCmd(t *testing.T, cmd *exec.Cmd, bound time.Duration) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(bound):
		_ = cmd.Process.Kill()
		t.Fatalf("prompt did not exit within %s", bound)
		return nil
	}
}

// TestCLIPromptInterruptWaitsForAbortAck: SIGINT must not exit until the
// leader says the turn stopped. Exiting on the signal alone used to drop the
// abort as the connection closed, and the cone kept working.
func TestCLIPromptInterruptWaitsForAbortAck(t *testing.T) {
	cmd, stderr, acked := holdPrompt(t, "3s", 400*time.Millisecond)
	err := waitCmd(t, cmd, 8*time.Second)
	exited := time.Now()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 130 {
		t.Fatalf("exit %v, want 130; stderr:\n%s", err, stderr.String())
	}
	select {
	case at := <-acked:
		if exited.Before(at) {
			t.Fatalf("exited at %s, ack sent at %s — prompt left before the leader confirmed", exited, at)
		}
	default:
		t.Fatal("leader never sent abort_ack")
	}
}

// TestCLIPromptInterruptReportsUnconfirmedStop: a leader that never confirms
// is a failed interrupt, not a clean 130. The bench runner treats that as the
// agent still going.
func TestCLIPromptInterruptReportsUnconfirmedStop(t *testing.T) {
	cmd, stderr, _ := holdPrompt(t, "400ms", 0)
	started := time.Now()
	err := waitCmd(t, cmd, 5*time.Second)
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("exit %v, want 1; stderr:\n%s", err, stderr.String())
	}
	if !strings.Contains(stderr.String(), "the leader did not confirm the turn stopped") {
		t.Fatalf("stderr = %q, want the unconfirmed-stop line", stderr.String())
	}
	if time.Since(started) < 300*time.Millisecond {
		t.Fatal("exited before the confirm bound")
	}
}

// promptLeader wires a bridged leader that answers the first user_message by
// replaying `frames` in order (with the given pauses) on its data channel.
// Every frame is a protocol struct; a time.Duration entry sleeps instead.
func promptLeader(t *testing.T, frames []any) *bridgedLeader {
	t.Helper()
	leader := newBridgedLeader(t)
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil || env.Type != "user_message" {
			return
		}
		go func() {
			for _, f := range frames {
				if d, ok := f.(time.Duration); ok {
					time.Sleep(d)
					continue
				}
				_ = sendJSON(leader.dc, f)
			}
		}()
	})
	return leader
}

func statusFrame(s string) protocol.Status {
	return protocol.Status{Type: protocol.TypeStatus, ScoopStatus: s}
}

func statusFrameFor(jid, s string) protocol.Status {
	st := statusFrame(s)
	st.ScoopJid = jid
	return st
}

func agentFrame(eventType, id, text string) protocol.AgentEventEnvelope {
	// No unit id: these tests speak for a leader that does not name frames.
	// A named frame is buffered until the prompt is bound.
	return agentFrameFor("", eventType, id, text)
}

func agentFrameFor(jid, eventType, id, text string) protocol.AgentEventEnvelope {
	return protocol.AgentEventEnvelope{
		Type: protocol.TypeAgentEvent, ScoopJid: jid,
		Event: protocol.AgentEvent{Type: eventType, MessageID: id, Text: text, Error: text},
	}
}

func runPrompt(t *testing.T, bin, joinURL string, settle time.Duration) (string, string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, joinURL, "prompt", "hi there")
	cmd.Env = append(os.Environ(), "SLICC_PROMPT_SETTLE="+settle.String())
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// TestCLIPromptWaitsThroughToolPhase: a live leader broadcasts `ready` at the
// end of every assistant MESSAGE, so a tool-using turn flips processing →
// ready → processing → ready. The first flip lands while the tool call is
// pending and must NOT end the prompt — even when the tool takes longer than
// the settle window.
func TestCLIPromptWaitsThroughToolPhase(t *testing.T) {
	bin := sliccBinary(t)
	leader := promptLeader(t, []any{
		statusFrame("processing"),
		agentFrame(protocol.AgentToolUseStart, "m1", "bash"),
		statusFrame("ready"),
		900 * time.Millisecond, // longer than the 300 ms settle window below
		agentFrame(protocol.AgentToolResult, "m1", "ok"),
		statusFrame("processing"),
		agentFrame(protocol.AgentContentDelta, "m2", "AFTER-TOOL-OK"),
		statusFrame("ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "AFTER-TOOL-OK") {
		t.Fatalf("prompt stdout = %q, want the post-tool reply", stdout)
	}
}

// TestCLIPromptWaitsForResumedTurn: a ready flip followed by more activity
// inside the settle window is withdrawn; the prompt keeps streaming.
func TestCLIPromptWaitsForResumedTurn(t *testing.T) {
	bin := sliccBinary(t)
	leader := promptLeader(t, []any{
		statusFrame("processing"),
		agentFrame(protocol.AgentContentDelta, "m1", "FIRST-"),
		statusFrame("ready"),
		100 * time.Millisecond,
		statusFrame("processing"),
		agentFrame(protocol.AgentContentDelta, "m2", "SECOND"),
		statusFrame("ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 400*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "FIRST-SECOND") {
		t.Fatalf("prompt stdout = %q, want both messages", stdout)
	}
}

// TestCLIPromptErrorAfterReady: the leader drops processing BEFORE it
// broadcasts the turn's error event. The prompt must report the error and
// exit 1, not exit 0 with an empty reply.
func TestCLIPromptErrorAfterReady(t *testing.T) {
	bin := sliccBinary(t)
	leader := promptLeader(t, []any{
		statusFrame("processing"),
		statusFrame("ready"),
		50 * time.Millisecond,
		agentFrame(protocol.AgentError, "", "Not signed in to Provider"),
	})
	_, stderr, err := runPrompt(t, bin, leader.joinURL, 400*time.Millisecond)
	if err == nil {
		t.Fatalf("prompt CLI exited 0; want exit 1 with the error; stderr:\n%s", stderr)
	}
	if !strings.Contains(stderr, "Not signed in to Provider") {
		t.Fatalf("stderr = %q, want the agent error", stderr)
	}
}

// ackLeader is promptLeader for a v10 leader: it first answers the
// user_message with `ack(messageId)`, then replays `frames`.
func ackLeader(t *testing.T, ack func(messageID string) protocol.UserMessageAck, frames []any) *bridgedLeader {
	t.Helper()
	leader := newBridgedLeader(t)
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var um protocol.UserMessage
		if json.Unmarshal(msg.Data, &um) != nil || um.Type != "user_message" {
			return
		}
		go func() {
			_ = sendJSON(leader.dc, ack(um.MessageID))
			for _, f := range frames {
				if d, ok := f.(time.Duration); ok {
					time.Sleep(d)
					continue
				}
				_ = sendJSON(leader.dc, f)
			}
		}()
	})
	return leader
}

func ackFrame(messageID, state, errMsg string) protocol.UserMessageAck {
	return protocol.UserMessageAck{
		Type: protocol.TypeUserMessageAck, MessageID: messageID, ScoopJid: "cone",
		State: state, Error: errMsg,
	}
}

// TestCLIPromptRejectedAckExits: a v10 leader that could not deliver the
// prompt sends a `rejected` ack and nothing else. The CLI must print the
// leader's error and exit 1 rather than wait for a turn that never starts.
func TestCLIPromptRejectedAckExits(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, func(id string) protocol.UserMessageAck {
		return ackFrame(id, protocol.AckRejected, "no agent to deliver to")
	}, nil)
	_, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("prompt err = %v, want exit 1; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stderr, "the leader rejected the prompt: no agent to deliver to") {
		t.Fatalf("stderr = %q, want the leader's rejection", stderr)
	}
}

// TestCLIPromptAcceptedAckKeepsWaiting: an `accepted` ack only says the
// prompt was taken; the CLI keeps streaming until the turn itself ends.
func TestCLIPromptAcceptedAckKeepsWaiting(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, func(id string) protocol.UserMessageAck {
		return ackFrame(id, protocol.AckAccepted, "")
	}, []any{
		500 * time.Millisecond,
		statusFrame("processing"),
		agentFrame(protocol.AgentContentDelta, "m1", "ACCEPTED-OK"),
		statusFrame("ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "ACCEPTED-OK") {
		t.Fatalf("prompt stdout = %q, want the reply streamed after the ack", stdout)
	}
}

// TestCLIPromptIgnoresOtherMessagesAck: a rejection keyed to a different
// messageId is not about this prompt and must not end it.
func TestCLIPromptIgnoresOtherMessagesAck(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, func(string) protocol.UserMessageAck {
		return ackFrame("someone-else", protocol.AckRejected, "not yours")
	}, []any{
		statusFrame("processing"),
		agentFrame(protocol.AgentContentDelta, "m1", "OWN-TURN-OK"),
		statusFrame("ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "OWN-TURN-OK") || strings.Contains(stderr, "not yours") {
		t.Fatalf("stdout = %q, stderr = %q; want the turn, not the foreign rejection", stdout, stderr)
	}
}

// TestCLIPromptIgnoresOtherScoopReady: the leader broadcasts every unit's
// status. A scoop going `ready` (or `initializing`) while the accepted unit
// is still in a tool call must not end `prompt` — that returned exit 0 and
// an empty reply while the cone kept working (BU Bench V2.1, 2026-09-26).
func TestCLIPromptIgnoresOtherScoopReady(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, func(id string) protocol.UserMessageAck {
		ack := ackFrame(id, protocol.AckAccepted, "")
		ack.ScoopJid = "cone-1"
		return ack
	}, []any{
		statusFrameFor("cone-1", "processing"),
		// No tool event yet: the cone is still on its first call. Another
		// unit going idle, and this unit leaving `processing` for
		// `initializing`, must not arm the settle timer.
		statusFrameFor("sports", "ready"),
		statusFrameFor("cone-1", "initializing"),
		900 * time.Millisecond, // longer than the 300 ms settle window
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m2", "AFTER-SCOOP-OK"),
		statusFrameFor("cone-1", "ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "AFTER-SCOOP-OK") {
		t.Fatalf("prompt stdout = %q, want the reply after the other scoop went ready", stdout)
	}
}

// TestCLIPromptStartupReadyDoesNotFinish: a 6.196.0 leader flips the cone
// processing → ready within a few milliseconds of accepting the prompt, before
// any agent event, and only then starts the turn. That ready must not settle.
func TestCLIPromptStartupReadyDoesNotFinish(t *testing.T) {
	bin := sliccBinary(t)
	leader := promptLeader(t, []any{
		statusFrame("processing"),
		statusFrame("ready"),
		900 * time.Millisecond,
		agentFrame(protocol.AgentContentDelta, "m1", "AFTER-BLIP-OK"),
		statusFrame("ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "AFTER-BLIP-OK") {
		t.Fatalf("prompt stdout = %q, want the reply after the startup ready", stdout)
	}
}

// TestCLIPromptNamedReadyBeforeAckDoesNotFinish: a 6.196.0 leader emits
// per-unit status as soon as the prompt is queued and only afterwards acks,
// often with the unit filled in. A `ready` in that gap used to start the
// settle timer while the prompt was still unbound, so `prompt` exited 0
// about 2s later.
func TestCLIPromptNamedReadyBeforeAckDoesNotFinish(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var um protocol.UserMessage
		if json.Unmarshal(msg.Data, &um) != nil || um.Type != "user_message" {
			return
		}
		go func() {
			_ = sendJSON(leader.dc, statusFrameFor("cone-1", "processing"))
			_ = sendJSON(leader.dc, statusFrameFor("sports", "ready"))
			time.Sleep(500 * time.Millisecond)
			ack := ackFrame(um.MessageID, protocol.AckAccepted, "")
			ack.ScoopJid = "cone-1"
			_ = sendJSON(leader.dc, ack)
			_ = sendJSON(leader.dc, agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "AFTER-ACK-OK"))
			_ = sendJSON(leader.dc, statusFrameFor("cone-1", "ready"))
		}()
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "AFTER-ACK-OK") {
		t.Fatalf("prompt stdout = %q, want the reply after the late ack", stdout)
	}
}

// TestCLIPromptEmptyAckUsesTheConeRoster: an accepted ack that names no unit
// must not fall back to "any named ready ends the turn". One root on
// `scoops.list` is the cone; a scoop's `ready` is not the prompt ending.
func TestCLIPromptEmptyAckUsesTheConeRoster(t *testing.T) {
	bin := sliccBinary(t)
	roster := map[string]any{
		"type": "scoops.list",
		"scoops": []any{
			map[string]any{"jid": "cone-1", "parentId": nil},
			map[string]any{"jid": "sports", "parentId": "cone-1"},
		},
		"activeScoopJid": "cone-1",
	}
	leader := ackLeader(t, func(id string) protocol.UserMessageAck {
		ack := ackFrame(id, protocol.AckAccepted, "")
		ack.ScoopJid = ""
		return ack
	}, []any{
		roster,
		statusFrameFor("cone-1", "processing"),
		statusFrameFor("sports", "ready"),
		900 * time.Millisecond,
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "CONE-ROSTER-OK"),
		statusFrameFor("cone-1", "ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "CONE-ROSTER-OK") {
		t.Fatalf("prompt stdout = %q, want the cone's reply", stdout)
	}
}

// TestCLIPromptBuffersForeignFramesUntilAck: events for other units arrive
// before the ack on a v10 leader. They must not print, finish, or leave a
// pending tool; the bound unit's own frames replay in order.
func TestCLIPromptBuffersForeignFramesUntilAck(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var um protocol.UserMessage
		if json.Unmarshal(msg.Data, &um) != nil || um.Type != "user_message" {
			return
		}
		go func() {
			_ = sendJSON(leader.dc, agentFrameFor("sports", protocol.AgentContentDelta, "x", "LEAK"))
			_ = sendJSON(leader.dc, agentFrameFor("sports", protocol.AgentToolUseStart, "x", "bash"))
			_ = sendJSON(leader.dc, agentFrameFor("sports", protocol.AgentTurnEnd, "x", ""))
			_ = sendJSON(leader.dc, agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "KEPT"))
			ack := ackFrame(um.MessageID, protocol.AckAccepted, "")
			ack.ScoopJid = "cone-1"
			_ = sendJSON(leader.dc, ack)
			_ = sendJSON(leader.dc, statusFrameFor("cone-1", "ready"))
		}()
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 200*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if strings.Contains(stdout, "LEAK") || !strings.Contains(stdout, "KEPT") {
		t.Fatalf("prompt stdout = %q, want only the bound unit's text", stdout)
	}
}

// TestCLIPromptIgnoresOtherScoopTurnEnd: a `turn_end` for a unit that did
// not accept this prompt is not the prompt's turn.
func TestCLIPromptIgnoresOtherScoopTurnEnd(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, func(id string) protocol.UserMessageAck {
		ack := ackFrame(id, protocol.AckAccepted, "")
		ack.ScoopJid = "cone-1"
		return ack
	}, []any{
		agentFrameFor("sports", protocol.AgentTurnEnd, "m-other", ""),
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "OWN-TURN-OK"),
		statusFrameFor("cone-1", "ready"),
	})
	stdout, stderr, err := runPrompt(t, bin, leader.joinURL, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "OWN-TURN-OK") {
		t.Fatalf("prompt stdout = %q, want the accepted unit's reply", stdout)
	}
}

// TestCLIFollowEvalPersistsState: `slicc <url> follow --eval <repl>` — the
// leader issues two exec.requests into ONE persistent runner process and the
// second sees state set by the first (the whole point of eval mode; per-command
// spawning would lose it). The stand-in REPL is the platform shell reading
// commands line-by-line from its stdin (`sh` / `cmd /q`), so this runs on every
// OS in the matrix without needing python/node installed.
func TestCLIFollowEvalPersistsState(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)

	evalRunner := []string{"sh"}
	setCmd := "x=EVAL-STATE-77"
	echoCmd := "echo $x"
	if runtime.GOOS == "windows" {
		evalRunner = []string{"cmd", "/q"}
		setCmd = "set x=EVAL-STATE-77"
		echoCmd = "echo %x%"
	}

	var mu sync.Mutex
	var got strings.Builder
	done := make(chan int, 1)

	leader.dc.OnOpen(func() {
		_ = sendJSON(leader.dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
		_ = sendJSON(leader.dc, protocol.ExecRequest{
			Type: protocol.TypeExecRequest, RequestID: "eval-1", Command: setCmd,
		})
	})
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil {
			return
		}
		switch env.Type {
		case protocol.TypeExecChunk:
			var ch protocol.ExecChunk
			if json.Unmarshal(msg.Data, &ch) != nil || ch.RequestID != "eval-2" {
				return
			}
			b, _ := base64.StdEncoding.DecodeString(ch.Data)
			mu.Lock()
			got.Write(b)
			mu.Unlock()
		case protocol.TypeExecResponse:
			var r protocol.ExecResponse
			if json.Unmarshal(msg.Data, &r) != nil {
				return
			}
			switch r.RequestID {
			case "eval-1":
				// State planted in the persistent shell; now read it back.
				_ = sendJSON(leader.dc, protocol.ExecRequest{
					Type: protocol.TypeExecRequest, RequestID: "eval-2", Command: echoCmd,
				})
			case "eval-2":
				select {
				case done <- r.ExitCode:
				default:
				}
			}
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	followArgs := append([]string{leader.joinURL, "follow", "--eval", "--eval-quiet=300ms"}, evalRunner...)
	cmd := exec.CommandContext(ctx, bin, followArgs...)
	cmd.Env = append(os.Environ(), "SLICC_DEBUG=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start eval follower: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("eval-2 exit=%d; follower stderr:\n%s", code, stderr.String())
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for the second eval response; follower stderr:\n%s", stderr.String())
	}
	mu.Lock()
	out := got.String()
	mu.Unlock()
	if !strings.Contains(out, "EVAL-STATE-77") {
		t.Fatalf("second command's output %q does not contain the state set by the first — the REPL did not persist", out)
	}
}
