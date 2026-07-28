// Package optel is a minimal, dependency-free Go client for Adobe's
// helix-rum-js wire protocol — the Real User Monitoring (RUM) beacon format
// shared by SLICC's webapp (packages/webapp/src/ui/telemetry.ts) and its
// native Swift counterpart (packages/swift-optel). See
// docs/operational-telemetry.md for the cross-float design.
//
// go-optel intentionally exposes a much smaller surface than swift-optel:
// headless CLI binaries have no UI to click on and no page to navigate, so
// only two checkpoints make sense — Enter (process launch) and Error
// (a fatal/operational failure). Callers should not reach for Click,
// Navigate, or the other UI-shaped checkpoints; the Checkpoint type stays
// open (a plain string) only so the wire format matches the other two
// implementations exactly.
//
// Every Sample/ReportError call MUST pass caller-controlled, non-sensitive
// values only. Use ReportError (which runs Sanitize internally) rather than
// passing a raw error's message directly — see sanitize.go for why that
// matters for a CLI that dials bearer-token URLs and runs on a user's
// machine.
package optel

import (
	"sync"
	"time"
)

// Client is a configured go-optel instance. The zero value is not usable —
// construct with Configure. A nil *Client is a valid, inert no-op for every
// method, so callers never need to guard a disabled/not-configured client.
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

// Options configures a Client. The zero value is the production default:
// weight-100 sampling, https://rum.hlx.page/, HTTPTransport with logging
// off.
type Options struct {
	// Rate selects the sampling weight (on/off/high/low; anything else,
	// including "", falls back to the default weight of 100).
	// OPTEL_RATE, when set in the environment, overrides this.
	Rate string
	// CollectBaseURL overrides DefaultCollectBaseURL.
	CollectBaseURL string
	// Transport overrides the default HTTPTransport (tests inject a mock).
	Transport Transport
	// RandomSource overrides the sampling coin flip's RNG (tests pin this
	// for determinism).
	RandomSource RandomSource
	// Debug forces wire-level transport logging on/off, taking precedence
	// over OPTEL_DEBUG when non-nil.
	Debug *bool
	// Environment overrides the process environment consulted for
	// OPTEL_RATE / OPTEL_DEBUG. Tests only; production callers leave this
	// nil to read the real environment.
	Environment map[string]string
}

// Configure builds a new Client and resolves its once-per-process sampling
// decision immediately. appID becomes the beacon `referer` hostname (see
// BuildReferer) — pass a stable, non-identifying label such as "slicc-cli",
// never a user- or machine-specific value.
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

// Sample records a checkpoint. Mirrors `sampleRUM(checkpoint, { source,
// target })`. The first call after Configure auto-emits a `top` beacon
// with t=0 first (matching helix-rum-js / swift-optel), unless the
// caller's own checkpoint IS Top, in which case the two fold into a single
// beacon. Nil-safe; an unselected session is a no-op (nothing is queued —
// unlike the browser/Swift collectors, a short-lived CLI process has no
// "attach session later" phase to buffer for).
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

// send fills in the session-scoped fields and hands the event to the
// transport. Caller must hold c.mu.
func (c *Client) send(event Event) {
	event.Weight = c.session.Weight
	event.ID = c.session.ID
	event.Referer = BuildReferer(c.appID, "/")
	c.transport.Send(event, c.collectBaseURL, &c.wg)
}

// ReportError samples an Error checkpoint with a sanitized target. source
// classifies the error (e.g. "dial", "update") and must itself be a fixed,
// caller-chosen label — never user-typed input. The message is run through
// Sanitize so absolute URLs (which may embed a join-URL bearer token) and
// filesystem paths never reach the wire. Nil-safe; a nil err is a no-op.
func (c *Client) ReportError(source string, err error) {
	if c == nil || err == nil {
		return
	}
	c.Sample(Error, source, Sanitize(err.Error()))
}

// Flush blocks until every beacon started by this Client has completed, or
// timeout elapses, whichever comes first. Call this (bounded) before
// process exit: unlike navigator.sendBeacon, a Go fire-and-forget goroutine
// has no guarantee of running past main() returning. A nil Client returns
// immediately.
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
