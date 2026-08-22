package tray

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ai-ecoverse/slicc-cli/internal/signaling"
)

func supersedeAttachResponse(next string) map[string]any {
	return map[string]any{
		"trayId": "t1", "role": "follower", "participantCount": 0,
		"result": map[string]any{
			"action": "fail", "code": "TRAY_SUPERSEDED",
			"error": "moved", "joinUrl": next,
		},
	}
}

func TestHandleAttachFailFollowsSupersede(t *testing.T) {
	var seen string
	opts := Options{OnJoinURLChanged: func(joinURL string) { seen = joinURL }}
	next, retry, err := handleAttachFail(&signaling.AttachPlan{
		Code: "TRAY_SUPERSEDED", JoinURL: "https://hub.example/join/b",
	}, 0, opts)
	if err != nil || !retry || next != "https://hub.example/join/b" {
		t.Fatalf("handleAttachFail() = (%q, %v, %v), want (b, true, nil)", next, retry, err)
	}
	if seen != "https://hub.example/join/b" {
		t.Fatalf("OnJoinURLChanged = %q", seen)
	}
}

func TestDialSupersedeMissingJoinURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"trayId": "t1", "role": "follower", "participantCount": 0,
			"result": map[string]any{
				"action": "fail", "code": "TRAY_SUPERSEDED", "error": "moved without replacement",
			},
		})
	}))
	defer srv.Close()

	_, err := Dial(context.Background(), srv.URL, Options{})
	if !IsSupersedeMissingJoin(err) {
		t.Fatalf("expected missing join error, got %v", err)
	}
}

func TestDialSupersedeChainExhausted(t *testing.T) {
	// Same host, hop query counts redirects; the hub still reports superseded
	// once maxSupersedeRetries have been followed.
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hop := 0
		if h := r.URL.Query().Get("hop"); h != "" {
			_, _ = fmt.Sscanf(h, "%d", &hop)
		}
		next := srv.URL
		if hop < maxSupersedeRetries+1 {
			next = srv.URL + "?hop=" + fmt.Sprint(hop+1)
		}
		_ = json.NewEncoder(w).Encode(supersedeAttachResponse(next))
	}))
	defer srv.Close()

	_, err := Dial(context.Background(), srv.URL, Options{})
	if !IsSupersedeChainExhausted(err) {
		t.Fatalf("expected chain exhausted, got %v", err)
	}
}
