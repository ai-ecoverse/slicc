package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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

// TestCLIWatchStreamsConeOutput: `slicc <url> watch` — a passive tail. The CLI
// sends nothing; the leader broadcasts a cone content delta and the CLI prints
// it to stdout. `watch` never exits on its own, so we read until the marker
// appears and then kill the long-lived watcher.
func TestCLIWatchStreamsConeOutput(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)

	const marker = "WATCH-E2E-OK"
	// A real cone jid is a generated uid, NOT the literal "cone". `watch` with no
	// scoop arg must print it anyway (no filter) — a regression guard for the
	// default-"cone"-filter bug that dropped every real delta.
	leader.dc.OnOpen(func() {
		_ = sendJSON(leader.dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
		_ = sendJSON(leader.dc, protocol.AgentEventEnvelope{
			Type: protocol.TypeAgentEvent, ScoopJid: "cone-7f3a2b91",
			Event: protocol.AgentEvent{Type: protocol.AgentContentDelta, MessageID: "m1", Text: marker},
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
		tmp := make([]byte, 128)
		for {
			n, rerr := stdout.Read(tmp)
			if n > 0 {
				buf = append(buf, tmp[:n]...)
				if strings.Contains(string(buf), marker) {
					got <- string(buf)
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
		if !strings.Contains(out, marker) {
			t.Fatalf("watch stdout = %q, want %q; stderr:\n%s", out, marker, stderr.String())
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
				Type: protocol.TypeAgentEvent, ScoopJid: "cone",
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
