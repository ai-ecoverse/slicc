package optel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestBuildBeaconURL(t *testing.T) {
	cases := []struct {
		base   string
		weight int
		want   string
	}{
		{"https://rum.hlx.page/", 100, "https://rum.hlx.page/.rum/100"},
		{"https://rum.hlx.page", 10, "https://rum.hlx.page/.rum/10"},
	}
	for _, c := range cases {
		got, err := buildBeaconURL(c.base, c.weight)
		if err != nil {
			t.Fatalf("buildBeaconURL(%q, %d): %v", c.base, c.weight, err)
		}
		if got != c.want {
			t.Errorf("buildBeaconURL(%q, %d) = %q, want %q", c.base, c.weight, got, c.want)
		}
	}
}

func TestHTTPTransportSendPostsExpectedShape(t *testing.T) {
	var (
		mu          sync.Mutex
		gotPath     string
		gotMethod   string
		gotContent  string
		gotEvent    Event
		requestSeen bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotContent = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotEvent)
		requestSeen = true
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	transport := NewHTTPTransport(false)
	event := Event{Weight: 100, ID: "abc123456", Referer: "https://slicc-cli/", Checkpoint: Enter, T: 0, Source: "prompt"}
	var wg sync.WaitGroup
	transport.Send(event, srv.URL+"/", &wg)

	waitWithTimeout(t, &wg, 2*time.Second)

	mu.Lock()
	defer mu.Unlock()
	if !requestSeen {
		t.Fatal("server never received a request")
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/.rum/100" {
		t.Errorf("path = %q, want /.rum/100", gotPath)
	}
	if gotContent != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContent)
	}
	if gotEvent.Checkpoint != Enter || gotEvent.Source != "prompt" {
		t.Errorf("decoded event = %+v", gotEvent)
	}
}

func TestHTTPTransportSendNeverBlocksCaller(t *testing.T) {
	// A server that never responds must not make Send itself block — only
	// Flush (via the WaitGroup) should ever wait on the network.
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		<-block
	}))
	defer func() {
		close(block)
		srv.Close()
	}()

	transport := &HTTPTransport{Client: &http.Client{Timeout: 200 * time.Millisecond}, Timeout: 200 * time.Millisecond}
	var wg sync.WaitGroup
	done := make(chan struct{})
	go func() {
		transport.Send(Event{Weight: 100, ID: "abc123456", Referer: "https://x/", Checkpoint: Enter}, srv.URL+"/", &wg)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Send blocked the caller")
	}
}

func TestHTTPTransportSendSwallowsErrors(t *testing.T) {
	transport := NewHTTPTransport(false)
	var wg sync.WaitGroup
	// An unroutable host: the goroutine's client.Do will fail; Send itself
	// must not panic or return an error value (it has none to return).
	transport.Send(Event{Weight: 100, ID: "abc123456", Referer: "https://x/", Checkpoint: Enter}, "http://127.0.0.1:1", &wg)
	waitWithTimeout(t, &wg, 2*time.Second)
}

func waitWithTimeout(t *testing.T, wg *sync.WaitGroup, timeout time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatal("timed out waiting for the WaitGroup")
	}
}
