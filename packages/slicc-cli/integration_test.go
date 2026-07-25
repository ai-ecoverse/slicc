package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ai-ecoverse/slicc-cli/internal/follow"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

// TestFollowerExecRoundTripOverWebRTC drives the follow-session path over a real
// WebRTC connection (pion ↔ pion on loopback): the leader issues an exec.request
// that the in-process follow session runs locally and streams back. Deterministic
// — no browser, no TURN. (The full-binary end-to-end coverage is in
// cli_e2e_test.go; this one exercises the internal follow session directly.)
func TestFollowerExecRoundTripOverWebRTC(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	leader := newBridgedLeader(t)
	var mu sync.Mutex
	var stdout strings.Builder
	gotResponse := make(chan int, 1)

	leader.dc.OnOpen(func() {
		_ = sendJSON(leader.dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
		_ = sendJSON(leader.dc, protocol.ExecRequest{
			Type: protocol.TypeExecRequest, RequestID: "r1", Command: "echo hello-over-webrtc",
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
			_ = json.Unmarshal(msg.Data, &ch)
			if ch.Stream == protocol.StreamStdout {
				b, _ := base64.StdEncoding.DecodeString(ch.Data)
				mu.Lock()
				stdout.Write(b)
				mu.Unlock()
			}
		case protocol.TypeExecResponse:
			var r protocol.ExecResponse
			_ = json.Unmarshal(msg.Data, &r)
			select {
			case gotResponse <- r.ExitCode:
			default:
			}
		}
	})

	conn, err := tray.Dial(ctx, leader.joinURL, tray.Options{
		Capabilities: &protocol.Capabilities{Exec: true},
		OnMessage: func(typ string, raw []byte) {
			select {
			case msgCh <- inbound{typ: typ, raw: raw}:
			default:
			}
		},
	})
	if err != nil {
		t.Fatalf("follower dial: %v", err)
	}
	defer conn.Close()

	session := follow.NewSession(conn, []string{"sh", "-c"}, nil)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-msgCh:
				session.Handle(ctx, m.typ, m.raw)
			}
		}
	}()

	select {
	case code := <-gotResponse:
		if code != 0 {
			t.Fatalf("exec exitCode = %d, want 0", code)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for exec.response over WebRTC")
	}
	mu.Lock()
	out := stdout.String()
	mu.Unlock()
	if !strings.Contains(out, "hello-over-webrtc") {
		t.Fatalf("stdout = %q, want to contain hello-over-webrtc", out)
	}
}

// msgCh buffers inbound messages for the integration test's follow session.
var msgCh = make(chan inbound, 64)
