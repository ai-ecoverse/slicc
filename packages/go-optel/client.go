package optel

import (
	"sync"
	"time"
)

type Client struct {
	mu             sync.Mutex
	appID          string
	collectBaseURL string
	transport      Transport
	session        Session
	sessionStart   time.Time
	hasEmittedTop  bool
	wg             sync.WaitGroup
}

type Options struct {
	Rate string

	CollectBaseURL string

	Transport Transport

	RandomSource RandomSource

	Debug *bool

	Environment map[string]string
}

func Configure(appID string, opts Options) *Client {
	rate := ResolveRate(opts.Rate, opts.Environment)
	debug := ResolveDebug(opts.Environment)
	if opts.Debug != nil {
		debug = *opts.Debug
	}
	collectBaseURL := opts.CollectBaseURL
	if collectBaseURL == "" {
		collectBaseURL = DefaultCollectBaseURL
	}
	transport := opts.Transport
	if transport == nil {
		transport = NewHTTPTransport(debug)
	}
	config := NewSamplingConfig(rate)
	session := NewSession(GenerateSessionID(), config, opts.RandomSource)

	return &Client{
		appID:          appID,
		collectBaseURL: collectBaseURL,
		transport:      transport,
		session:        session,
		sessionStart:   time.Now(),
	}
}

func (c *Client) Sample(checkpoint Checkpoint, source, target string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.session.Selected {
		return
	}
	isFirst := !c.hasEmittedTop
	c.hasEmittedTop = true
	isTopRequest := checkpoint == Top
	if isFirst && !isTopRequest {
		c.send(Event{Checkpoint: Top, T: 0})
	}
	t := 0
	if !isFirst || !isTopRequest {
		t = int(time.Since(c.sessionStart) / time.Millisecond)
		if t < 0 {
			t = 0
		}
	}
	c.send(Event{Checkpoint: checkpoint, T: t, Source: source, Target: target})
}

func (c *Client) send(event Event) {
	event.Weight = c.session.Weight
	event.ID = c.session.ID
	event.Referer = BuildReferer(c.appID, "/")
	c.transport.Send(event, c.collectBaseURL, &c.wg)
}

func (c *Client) ReportError(source string, err error) {
	if c == nil || err == nil {
		return
	}
	c.Sample(Error, source, Sanitize(err.Error()))
}

func (c *Client) Flush(timeout time.Duration) {
	if c == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}
