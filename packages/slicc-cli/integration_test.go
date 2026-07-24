package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ai-ecoverse/slicc-cli/internal/follow"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

// TestFollowerExecRoundTripOverWebRTC drives the whole follower path over a real
// WebRTC connection (pion ↔ pion on loopback): a leader peer creates the
// tray-control channel, a mock signaling server bridges the SDP/ICE exchange to
// the CLI's tray.Dial, and the leader issues an exec.request that the follow
// session runs locally and streams back. Deterministic — no browser, no TURN.
func TestFollowerExecRoundTripOverWebRTC(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	leaderPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("leader peer connection: %v", err)
	}
	defer func() { _ = leaderPC.Close() }()

	dc, err := leaderPC.CreateDataChannel("tray-control", nil)
	if err != nil {
		t.Fatalf("data channel: %v", err)
	}

	var mu sync.Mutex
	var stdout strings.Builder
	gotResponse := make(chan int, 1)

	dc.OnOpen(func() {
		_ = sendJSON(dc, protocol.Hello{Type: protocol.TypeHello, ProtocolVersion: 1})
		_ = sendJSON(dc, protocol.ExecRequest{
			Type: protocol.TypeExecRequest, RequestID: "r1", Command: "echo hello-over-webrtc",
		})
	})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
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

	// Gather the leader's candidates into the offer (non-trickle) so the mock
	// signaling only has to relay the offer + the follower's trickled answer/ICE.
	offer, err := leaderPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(leaderPC)
	if err := leaderPC.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	<-gatherComplete
	offerSDP := leaderPC.LocalDescription().SDP

	var smu sync.Mutex
	offerSent := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch action, _ := body["action"].(string); action {
		case "": // attach
			writeJSONResp(w, map[string]any{
				"trayId": "t1", "controllerId": body["controllerId"], "role": "follower", "participantCount": 1,
				"result":     map[string]any{"action": "signal", "code": "LEADER_CONNECTED", "bootstrap": bstrap(0)},
				"iceServers": []any{},
			})
		case "poll":
			smu.Lock()
			var events []any
			if !offerSent {
				offerSent = true
				events = []any{map[string]any{
					"sequence": 0, "sentAt": "t", "type": "bootstrap.offer",
					"offer": map[string]any{"type": "offer", "sdp": offerSDP},
				}}
			}
			smu.Unlock()
			writeJSONResp(w, bootstrapResp(events))
		case "answer":
			ans, _ := body["answer"].(map[string]any)
			sdp, _ := ans["sdp"].(string)
			_ = leaderPC.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
			writeJSONResp(w, bootstrapResp(nil))
		case "ice-candidate":
			cand, _ := body["candidate"].(map[string]any)
			cstr, _ := cand["candidate"].(string)
			init := webrtc.ICECandidateInit{Candidate: cstr}
			if mid, ok := cand["sdpMid"].(string); ok {
				init.SDPMid = &mid
			}
			if idx, ok := cand["sdpMLineIndex"].(float64); ok {
				u := uint16(idx)
				init.SDPMLineIndex = &u
			}
			_ = leaderPC.AddICECandidate(init)
			writeJSONResp(w, bootstrapResp(nil))
		default:
			writeJSONResp(w, bootstrapResp(nil))
		}
	}))
	defer srv.Close()

	conn, err := tray.Dial(ctx, srv.URL, tray.Options{
		Capabilities: &protocol.Capabilities{Exec: true},
		OnMessage: func(typ string, raw []byte) {
			// Route to the follow session (buffered; drained below).
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

func sendJSON(dc *webrtc.DataChannel, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return dc.SendText(string(b))
}

func writeJSONResp(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func bstrap(cursor int) map[string]any {
	return map[string]any{
		"controllerId": "ctrl", "bootstrapId": "b1", "attempt": 1, "state": "offered",
		"expiresAt": "2030-01-01T00:00:00Z", "cursor": cursor, "maxRetries": 3,
		"retriesRemaining": 3, "retryAfterMs": nil, "failure": nil,
	}
}

func bootstrapResp(events []any) map[string]any {
	if events == nil {
		events = []any{}
	}
	return map[string]any{
		"trayId": "t1", "controllerId": "ctrl", "role": "follower", "participantCount": 1,
		"bootstrap": bstrap(1), "events": events, "iceServers": []any{},
	}
}
