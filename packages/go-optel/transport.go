package optel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// DefaultTimeout is the per-request timeout used when HTTPTransport.Timeout
// is zero.
const DefaultTimeout = 10 * time.Second

// Transport sends a single Event to the collector. Implementations must
// never block the caller for the network round trip — this is the Go
// analogue of navigator.sendBeacon / swift-optel's OptelTransport.
type Transport interface {
	// Send enqueues the event for delivery. When wg is non-nil, Send must
	// call wg.Add(1) before returning and wg.Done() once the underlying
	// network attempt (success or failure) completes, so Client.Flush can
	// bound how long it waits for in-flight beacons at process exit.
	Send(event Event, collectBaseURL string, wg *sync.WaitGroup)
}

// HTTPTransport is the default Transport, backed by net/http. Mirrors
// swift-optel's URLSessionOptelTransport:
//   - POST {collectBaseURL}.rum/{weight} with Content-Type: application/json
//   - the request runs in its own goroutine so Send never blocks the caller
//   - a short per-request timeout bounds a stuck collector
//   - every error is swallowed; nothing is retried
type HTTPTransport struct {
	Client  *http.Client
	Timeout time.Duration
	// Debug, when non-nil, receives one line per beacon attempt (URL, byte
	// count, and — on completion — status code or error). Off by default;
	// wired from OPTEL_DEBUG / Options.Debug.
	Debug func(format string, args ...any)
}

// NewHTTPTransport builds a production HTTPTransport. debug installs a
// log.Printf-based Debug sink; false leaves it nil (no logging, no
// behavior change).
func NewHTTPTransport(debug bool) *HTTPTransport {
	t := &HTTPTransport{
		Client:  &http.Client{Timeout: DefaultTimeout},
		Timeout: DefaultTimeout,
	}
	if debug {
		t.Debug = log.Printf
	}
	return t
}

// Send implements Transport.
func (t *HTTPTransport) Send(event Event, collectBaseURL string, wg *sync.WaitGroup) {
	body, err := json.Marshal(event)
	if err != nil {
		return
	}
	reqURL, err := buildBeaconURL(collectBaseURL, event.Weight)
	if err != nil {
		return
	}
	client := t.Client
	if client == nil {
		client = &http.Client{Timeout: DefaultTimeout}
	}
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	debug := t.Debug
	if wg != nil {
		wg.Add(1)
	}
	go func() {
		if wg != nil {
			defer wg.Done()
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
		if reqErr != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if debug != nil {
			debug("optel beacon -> %s (%d bytes)", reqURL, len(body))
		}
		res, doErr := client.Do(req)
		if doErr != nil {
			if debug != nil {
				debug("optel beacon error: %s", doErr)
			}
			return
		}
		defer func() { _ = res.Body.Close() }()
		if debug != nil {
			debug("optel beacon <- %s status=%d", reqURL, res.StatusCode)
		}
	}()
}

// buildBeaconURL resolves ".rum/<weight>" relative to collectBaseURL,
// matching `new URL('.rum/' + weight, collectBaseURL)` in helix-rum-js and
// `URL(string:relativeTo:)` in swift-optel.
func buildBeaconURL(collectBaseURL string, weight int) (string, error) {
	base, err := url.Parse(collectBaseURL)
	if err != nil {
		return "", err
	}
	rel, err := url.Parse(fmt.Sprintf(".rum/%d", weight))
	if err != nil {
		return "", err
	}
	return base.ResolveReference(rel).String(), nil
}
