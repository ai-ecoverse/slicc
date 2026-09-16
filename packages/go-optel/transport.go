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

const DefaultTimeout = 10 * time.Second

type Transport interface {
	Send(event Event, collectBaseURL string, wg *sync.WaitGroup)
}

type HTTPTransport struct {
	Client  *http.Client
	Timeout time.Duration

	Debug func(format string, args ...any)
}

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
