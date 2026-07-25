package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"

	"github.com/pion/webrtc/v4"
)

// testRunner is the platform shell the exec tests hand commands to
// (`echo` / `exit` work under both), so the suite runs — not skips — on Windows.
func testRunner() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd", "/c"}
	}
	return []string{"sh", "-c"}
}

// bridgedLeader is a pion leader peer plus a mock signaling server that bridges a
// follower's HTTP signaling (attach → poll/answer/ice) to it — the deterministic,
// no-browser stand-in for a real SLICC leader used by the WebRTC e2e tests.
// Wire dc.OnOpen / dc.OnMessage before the follower connects.
type bridgedLeader struct {
	pc      *webrtc.PeerConnection
	dc      *webrtc.DataChannel
	joinURL string
}

// newBridgedLeader builds the leader peer + tray-control channel + signaling
// bridge and returns once it's ready to accept a follower at `joinURL`.
func newBridgedLeader(t *testing.T) *bridgedLeader {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("leader peer connection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	dc, err := pc.CreateDataChannel("tray-control", nil)
	if err != nil {
		t.Fatalf("data channel: %v", err)
	}

	// Non-trickle: gather the leader's candidates into the offer so the mock
	// signaling only relays the offer + the follower's trickled answer/ICE.
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local description: %v", err)
	}
	<-gatherComplete
	offerSDP := pc.LocalDescription().SDP

	var mu sync.Mutex
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
			mu.Lock()
			var events []any
			if !offerSent {
				offerSent = true
				events = []any{map[string]any{
					"sequence": 0, "sentAt": "t", "type": "bootstrap.offer",
					"offer": map[string]any{"type": "offer", "sdp": offerSDP},
				}}
			}
			mu.Unlock()
			writeJSONResp(w, bootstrapResp(events))
		case "answer":
			ans, _ := body["answer"].(map[string]any)
			sdp, _ := ans["sdp"].(string)
			_ = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
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
			_ = pc.AddICECandidate(init)
			writeJSONResp(w, bootstrapResp(nil))
		default:
			writeJSONResp(w, bootstrapResp(nil))
		}
	}))
	t.Cleanup(srv.Close)

	return &bridgedLeader{pc: pc, dc: dc, joinURL: srv.URL}
}

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
