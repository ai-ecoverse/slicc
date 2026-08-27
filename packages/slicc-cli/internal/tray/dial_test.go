package tray

import (
	"context"
	"encoding/json"
	"errors"
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

func TestFollowSupersedeReportsTheReplacement(t *testing.T) {
	var seen string
	opts := Options{OnJoinURLChanged: func(joinURL string) { seen = joinURL }}
	next, err := followSupersede(&signaling.AttachPlan{
		Code: "TRAY_SUPERSEDED", JoinURL: "https://hub.example/join/b",
	}, 0, opts)
	if err != nil || next != "https://hub.example/join/b" {
		t.Fatalf("followSupersede() = (%q, %v), want (b, nil)", next, err)
	}
	if seen != "https://hub.example/join/b" {
		t.Fatalf("OnJoinURLChanged = %q", seen)
	}
}

func TestFollowSupersedeBoundsTheChain(t *testing.T) {
	_, err := followSupersede(&signaling.AttachPlan{
		Code: "TRAY_SUPERSEDED", JoinURL: "https://hub.example/join/b",
	}, maxSupersedeRetries, Options{})
	if !IsSupersedeChainExhausted(err) {
		t.Fatalf("expected chain exhausted, got %v", err)
	}
}

// A supersede plan that names no replacement is the only one that still
// reaches handleAttachFail — everything with a JoinURL is followed first.
func TestHandleAttachFailSupersedeWithoutReplacement(t *testing.T) {
	err := handleAttachFail(&signaling.AttachPlan{Code: "TRAY_SUPERSEDED", Error: "moved"})
	if !IsSupersedeMissingJoin(err) {
		t.Fatalf("expected missing join error, got %v", err)
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

// #1957: the hub can name the replacement in a `successor-version` link alone.
// A follower that keys off the body's fail code strands here; one that reads
// the header hops.
func TestDialFollowsSuccessorVersionLinkWithoutBodyCode(t *testing.T) {
	var hops []string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops = append(hops, r.URL.String())
		if r.URL.Query().Get("hop") == "1" {
			w.WriteHeader(http.StatusGone)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"trayId": "t2", "role": "follower", "participantCount": 0,
				"result": map[string]any{"action": "fail", "code": "TRAY_EXPIRED", "error": "gone"},
			})
			return
		}
		w.Header().Set("Link", "<"+srv.URL+`?hop=1>; rel="successor-version", `+
			"<"+srv.URL+`/status>; rel="status"`)
		w.WriteHeader(http.StatusConflict)
		// A body shape this build does not model — the link still carries it.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"trayId": "t1", "role": "follower", "participantCount": 0,
			"result": map[string]any{"action": "redirect", "code": "TRAY_SUPERSEDED", "error": "moved"},
		})
	}))
	defer srv.Close()

	var seen string
	_, err := Dial(context.Background(), srv.URL, Options{
		OnJoinURLChanged: func(joinURL string) { seen = joinURL },
	})
	var attachErr *AttachError
	if !errors.As(err, &attachErr) || attachErr.Code != "TRAY_EXPIRED" {
		t.Fatalf("expected to land on the replacement tray, got %v", err)
	}
	if seen != srv.URL+"?hop=1" {
		t.Fatalf("OnJoinURLChanged = %q", seen)
	}
	if len(hops) != 2 {
		t.Fatalf("expected 2 attaches, got %v", hops)
	}
}

// The link also redeems a response whose body cannot be decoded at all.
func TestDialFollowsSuccessorVersionLinkWithUndecodableBody(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("hop") == "1" {
			w.WriteHeader(http.StatusGone)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"trayId": "t2", "role": "follower", "participantCount": 0,
				"result": map[string]any{"action": "fail", "code": "TRAY_EXPIRED", "error": "gone"},
			})
			return
		}
		w.Header().Set("Link", "<"+srv.URL+`?hop=1>; rel="successor-version"`)
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte("<html>gateway error</html>"))
	}))
	defer srv.Close()

	_, err := Dial(context.Background(), srv.URL, Options{})
	var attachErr *AttachError
	if !errors.As(err, &attachErr) || attachErr.Code != "TRAY_EXPIRED" {
		t.Fatalf("expected to land on the replacement tray, got %v", err)
	}
}

// The link outranks a stale joinUrl in the body.
func TestDialPrefersLinkOverBodyJoinURL(t *testing.T) {
	var hops []string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops = append(hops, r.URL.String())
		if r.URL.Query().Get("from") != "" {
			w.WriteHeader(http.StatusGone)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"trayId": "t2", "role": "follower", "participantCount": 0,
				"result": map[string]any{"action": "fail", "code": "TRAY_EXPIRED", "error": "gone"},
			})
			return
		}
		w.Header().Set("Link", "<"+srv.URL+`?from=link>; rel="successor-version"`)
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(supersedeAttachResponse(srv.URL + "?from=body"))
	}))
	defer srv.Close()

	_, _ = Dial(context.Background(), srv.URL, Options{})
	if len(hops) != 2 || hops[1] != "/?from=link" {
		t.Fatalf("expected the link target to win, hops = %v", hops)
	}
}
