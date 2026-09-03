package signaling

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func bootstrapObj(id string, cursor int) map[string]any {
	return map[string]any{
		"controllerId":     "ctrl",
		"bootstrapId":      id,
		"attempt":          1,
		"state":            "offered",
		"expiresAt":        "2030-01-01T00:00:00Z",
		"cursor":           cursor,
		"maxRetries":       3,
		"retriesRemaining": 3,
		"retryAfterMs":     nil,
		"failure":          nil,
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// newMock returns a server whose response is chosen by the request's "action".
func newMock(t *testing.T, handler func(action string, body map[string]any) any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		action, _ := body["action"].(string)
		writeJSON(w, handler(action, body))
	}))
}

func TestAttachSignal(t *testing.T) {
	srv := newMock(t, func(_ string, body map[string]any) any {
		return map[string]any{
			"trayId": "t1", "controllerId": body["controllerId"], "role": "follower", "participantCount": 1,
			"result":     map[string]any{"action": "signal", "code": "LEADER_CONNECTED", "bootstrap": bootstrapObj("b1", 0)},
			"iceServers": []any{map[string]any{"urls": []string{"stun:stun.example:3478"}, "username": "u", "credential": "c"}},
		}
	})
	defer srv.Close()

	plan, err := New(srv.URL, nil).Attach(context.Background(), "ctrl", "slicc-cli")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if plan.Action != "signal" {
		t.Fatalf("action = %q, want signal", plan.Action)
	}
	if plan.Bootstrap == nil || plan.Bootstrap.BootstrapID != "b1" {
		t.Fatalf("bootstrap = %+v, want id b1", plan.Bootstrap)
	}
	if len(plan.IceServers) != 1 || plan.IceServers[0].Username != "u" {
		t.Fatalf("iceServers = %+v", plan.IceServers)
	}
}

func TestAttachWaitAndSupersede(t *testing.T) {
	waitSrv := newMock(t, func(_ string, body map[string]any) any {
		return map[string]any{
			"trayId": "t1", "controllerId": body["controllerId"], "role": "follower", "participantCount": 0,
			"result": map[string]any{"action": "wait", "code": "LEADER_NOT_CONNECTED", "retryAfterMs": 250},
		}
	})
	defer waitSrv.Close()
	plan, err := New(waitSrv.URL, nil).Attach(context.Background(), "ctrl", "slicc-cli")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if plan.Action != "wait" || plan.RetryAfterMs != 250 {
		t.Fatalf("wait plan = %+v", plan)
	}

	supersedeSrv := newMock(t, func(_ string, body map[string]any) any {
		return map[string]any{
			"trayId": "t1", "controllerId": body["controllerId"], "role": "follower", "participantCount": 0,
			"result": map[string]any{"action": "fail", "code": "TRAY_SUPERSEDED", "error": "moved", "joinUrl": "https://x/join/new"},
		}
	})
	defer supersedeSrv.Close()
	plan, err = New(supersedeSrv.URL, nil).Attach(context.Background(), "ctrl", "slicc-cli")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if plan.Action != "fail" || plan.Code != "TRAY_SUPERSEDED" || plan.JoinURL != "https://x/join/new" {
		t.Fatalf("supersede plan = %+v", plan)
	}
}

// A 308 supersede must be reported as a hop, not followed by net/http: the
// caller owns the hop bound and the persistence of the replacement (#1957).
func TestAttachReadsSupersede308WithoutFollowingIt(t *testing.T) {
	fresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("net/http followed the 308; the hop must be reported to the caller")
		writeJSON(w, map[string]any{})
	}))
	defer fresh.Close()

	stale := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", fresh.URL+"/join/new?json=true")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPermanentRedirect)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"trayId": "t1", "controllerId": "ctrl", "role": "follower", "participantCount": 0,
			"result": map[string]any{
				"action": "redirect", "code": "TRAY_SUPERSEDED", "error": "moved",
				"joinUrl": fresh.URL + "/join/new",
			},
		})
	}))
	defer stale.Close()

	plan, err := New(stale.URL, nil).Attach(context.Background(), "ctrl", "slicc-cli")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if plan.JoinURL != fresh.URL+"/join/new" {
		t.Fatalf("joinURL = %q, want %q", plan.JoinURL, fresh.URL+"/join/new")
	}
	if plan.Code != "TRAY_SUPERSEDED" {
		t.Fatalf("code = %q, want TRAY_SUPERSEDED", plan.Code)
	}
}

// A hub that sends only Location — no link, no body — is still a redirect.
func TestAttachFallsBackToLocationHeader(t *testing.T) {
	stale := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "https://hub.example/join/new?json=true")
		w.WriteHeader(http.StatusPermanentRedirect)
	}))
	defer stale.Close()

	plan, err := New(stale.URL, nil).Attach(context.Background(), "ctrl", "slicc-cli")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	// json=true is the hub's auto-follow guard, not part of the join URL.
	if plan.JoinURL != "https://hub.example/join/new" {
		t.Fatalf("joinURL = %q", plan.JoinURL)
	}
}

func TestRedirectLocation(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		location string
		want     string
	}{
		{"308 strips the probe param", 308, "https://h/join/n?json=true", "https://h/join/n"},
		{"307 is a hop too", 307, "https://h/join/n", "https://h/join/n"},
		{"other query params survive", 308, "https://h/join/n?a=1&json=true", "https://h/join/n?a=1"},
		{"not a redirect", 200, "https://h/join/n", ""},
		{"409 is terminal", 409, "https://h/join/n", ""},
		{"no location", 308, "", ""},
		{"relative target", 308, "/join/n", ""},
		{"schemeless target", 308, "//h/join/n", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RedirectLocation(tc.status, tc.location); got != tc.want {
				t.Fatalf("RedirectLocation(%d, %q) = %q, want %q", tc.status, tc.location, got, tc.want)
			}
		})
	}
}

// The caller's client must come back unmodified — New copies it before
// installing CheckRedirect.
func TestNewDoesNotMutateCallerClient(t *testing.T) {
	caller := &http.Client{}
	New("https://hub.example/join/t", caller)
	if caller.CheckRedirect != nil {
		t.Fatal("New mutated the caller's http.Client")
	}
}

func TestPollDecodesEvents(t *testing.T) {
	srv := newMock(t, func(action string, body map[string]any) any {
		base := map[string]any{"trayId": "t1", "controllerId": body["controllerId"], "role": "follower", "participantCount": 1, "bootstrap": bootstrapObj("b1", 2)}
		switch action {
		case "poll":
			base["events"] = []any{
				map[string]any{"sequence": 0, "sentAt": "t", "type": "bootstrap.offer", "offer": map[string]any{"type": "offer", "sdp": "v=0"}},
				map[string]any{"sequence": 1, "sentAt": "t", "type": "bootstrap.ice_candidate", "candidate": map[string]any{"candidate": "cand", "sdpMid": "0", "sdpMLineIndex": 0}},
			}
		default:
			base["events"] = []any{}
		}
		return base
	})
	defer srv.Close()

	client := New(srv.URL, nil)
	ctx := context.Background()
	poll, err := client.Poll(ctx, "ctrl", "b1", 0)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if poll.Bootstrap.Cursor != 2 {
		t.Fatalf("cursor = %d, want 2", poll.Bootstrap.Cursor)
	}
	if len(poll.Events) != 2 {
		t.Fatalf("events = %d, want 2", len(poll.Events))
	}
	if poll.Events[0].Type != "bootstrap.offer" || poll.Events[0].Offer == nil || poll.Events[0].Offer.SDP != "v=0" {
		t.Fatalf("offer event = %+v", poll.Events[0])
	}
	if poll.Events[1].Type != "bootstrap.ice_candidate" || poll.Events[1].Candidate == nil || poll.Events[1].Candidate.Candidate != "cand" {
		t.Fatalf("ice event = %+v", poll.Events[1])
	}

	// answer / ice / retry all decode the same bootstrap envelope.
	if _, err := client.SendAnswer(ctx, "ctrl", "b1", "v=0"); err != nil {
		t.Fatalf("answer: %v", err)
	}
	sdpMid := "0"
	if _, err := client.SendICECandidate(ctx, "ctrl", "b1", IceCandidate{Candidate: "cand", SDPMid: &sdpMid}); err != nil {
		t.Fatalf("ice: %v", err)
	}
	if _, err := client.Retry(ctx, "ctrl", "b1", "slicc-cli"); err != nil {
		t.Fatalf("retry: %v", err)
	}
}
