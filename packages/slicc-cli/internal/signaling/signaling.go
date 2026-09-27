// Package signaling implements the follower half of the tray signaling wire
// contract (packages/shared-ts/src/tray-signaling.ts): the HTTP attach loop and
// the bootstrap poll/answer/ice-candidate/retry exchange with the Cloudflare
// tray-hub worker. It is a direct port of the proven iOS follower connector
// (packages/ios-app/SliccTrayKit/Networking/TraySignaling.swift), including the
// TRAY_SUPERSEDED redirect — every float now follows it, bounded at five hops
// (see SupersedeRedirect.swift and tray-webrtc.ts).
package signaling

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// defaultRequestTimeout bounds each signaling HTTP request. http.DefaultClient
// has no timeout, so without this a server that accepts the connection and never
// replies would hang attach/poll forever (the bootstrap deadline is only checked
// between requests).
const defaultRequestTimeout = 30 * time.Second

// A deploy resets the tray Durable Object for a few seconds. The hub answers
// that with JSON 503, and an uncaught reset still arrives as Cloudflare's
// plain-text "error code: 1101" page. Both are safe to repeat: nothing has
// been delivered to the leader yet. The whole retry, including every request
// and the backoff between them, stays inside signalingRetryBudget. A single
// attempt is also capped at defaultRequestTimeout, and it never starts once
// the budget is already spent.
const (
	signalingAttempts    = 4
	signalingRetryBase   = time.Second
	signalingRetryMax    = 4 * time.Second
	signalingRetryBudget = 8 * time.Second
)

// TurnIceServer mirrors the worker-supplied ICE server list.
type TurnIceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

// SessionDescription is an SDP offer/answer.
type SessionDescription struct {
	Type string `json:"type"` // "offer" | "answer"
	SDP  string `json:"sdp"`
}

// IceCandidate is a trickled ICE candidate.
type IceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// BootstrapFailure describes a failed bootstrap attempt.
type BootstrapFailure struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Retryable  bool   `json:"retryable"`
	RetryAfter *int   `json:"retryAfterMs"`
	FailedAt   string `json:"failedAt"`
}

// BootstrapStatus is the server's current view of a bootstrap.
type BootstrapStatus struct {
	ControllerID     string            `json:"controllerId"`
	BootstrapID      string            `json:"bootstrapId"`
	Attempt          int               `json:"attempt"`
	State            string            `json:"state"`
	ExpiresAt        string            `json:"expiresAt"`
	Cursor           int               `json:"cursor"`
	MaxRetries       int               `json:"maxRetries"`
	RetriesRemaining int               `json:"retriesRemaining"`
	RetryAfterMs     *int              `json:"retryAfterMs"`
	Failure          *BootstrapFailure `json:"failure"`
}

// BootstrapEvent is one cursor-ordered bootstrap event.
type BootstrapEvent struct {
	Sequence  int                 `json:"sequence"`
	SentAt    string              `json:"sentAt"`
	Type      string              `json:"type"` // bootstrap.offer | bootstrap.ice_candidate | bootstrap.failed
	Offer     *SessionDescription `json:"offer,omitempty"`
	Candidate *IceCandidate       `json:"candidate,omitempty"`
	Failure   *BootstrapFailure   `json:"failure,omitempty"`
}

// AttachPlan is the normalized attach outcome.
type AttachPlan struct {
	Action       string // "wait" | "signal" | "fail"
	Code         string
	RetryAfterMs int
	Error        string
	Bootstrap    *BootstrapStatus
	IceServers   []TurnIceServer
	// JoinURL is the replacement tray to follow — from the `successor-version`
	// Link header, or the body's TRAY_SUPERSEDED joinUrl. Non-empty means the
	// tray moved, whatever Action/Code say.
	JoinURL string
	TrayID  string
}

// BootstrapPlan is the normalized poll/answer/ice/retry outcome.
type BootstrapPlan struct {
	Bootstrap BootstrapStatus
	Events    []BootstrapEvent
}

// Client posts follower signaling requests to a single join URL.
type Client struct {
	joinURL string
	http    *http.Client
	logf    func(string, ...any)
	// sleep is the backoff between transient attempts. Tests replace it.
	sleep func(context.Context, time.Duration) bool
	// retryBudget overrides signalingRetryBudget. Tests set a short one so a
	// stalled server does not hold the suite for the production budget.
	retryBudget time.Duration
}

// New builds a signaling client for the given join URL.
//
// Redirect-following is suppressed on the copy of the caller's client: the 308
// a superseded tray answers with (#1957) is a hop this package reports to
// tray.Dial, which owns the five-hop bound and the OnJoinURLChanged
// persistence. Letting net/http follow it would re-POST to the replacement and
// connect, but leave the caller's stored join URL naming a dead tray — so every
// later reconnect would start from the redirect again.
func New(joinURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultRequestTimeout}
	}
	client := *httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{joinURL: joinURL, http: &client, sleep: sleepSignaling}
}

// SetLogf receives one line per transient retry. Nil discards them. The
// returned error still names the status and body when the budget runs out.
func (c *Client) SetLogf(fn func(string, ...any)) { c.logf = fn }

// JoinURL returns the URL this client posts to.
func (c *Client) JoinURL() string { return c.joinURL }

type rawAttachResponse struct {
	TrayID           string `json:"trayId"`
	Role             string `json:"role"`
	ParticipantCount int    `json:"participantCount"`
	Result           struct {
		Action       string           `json:"action"`
		Code         string           `json:"code"`
		RetryAfterMs *int             `json:"retryAfterMs"`
		Error        string           `json:"error"`
		Bootstrap    *BootstrapStatus `json:"bootstrap"`
		JoinURL      string           `json:"joinUrl"`
	} `json:"result"`
	IceServers []TurnIceServer `json:"iceServers"`
}

type rawBootstrapResponse struct {
	Role      string           `json:"role"`
	Bootstrap BootstrapStatus  `json:"bootstrap"`
	Events    []BootstrapEvent `json:"events"`
}

// Attach performs the first join call.
func (c *Client) Attach(ctx context.Context, controllerID, runtime string) (*AttachPlan, error) {
	body := map[string]any{"controllerId": controllerID, "runtime": runtime}
	data, meta, err := c.postWithMeta(ctx, body)
	if err != nil {
		return nil, err
	}
	// #1957: a superseded tray states the replacement three times — as the 308's
	// Location, as an RFC 5829 `successor-version` link, and in the body. The
	// link is preferred: it is the canonical join URL (Location carries the
	// hub's json=true) and it survives a body-shape change. Any one of them
	// alone is enough to follow the hop, so a body this build cannot decode is
	// not a dead end when the hub told us where the tray went.
	successor := firstNonEmpty(
		SuccessorVersionFromLinkHeader(meta.Header),
		RedirectLocation(meta.Status, meta.Header.Get("Location")),
	)
	var raw rawAttachResponse
	if err := json.Unmarshal(data, &raw); err != nil {
		if successor != "" {
			return &AttachPlan{Action: "fail", Code: "TRAY_SUPERSEDED", JoinURL: successor}, nil
		}
		return nil, fmt.Errorf("tray attach: invalid response: %w (body: %s)", err, truncate(data))
	}
	if raw.Role != "follower" {
		if successor != "" {
			return &AttachPlan{Action: "fail", Code: "TRAY_SUPERSEDED", JoinURL: successor}, nil
		}
		return nil, fmt.Errorf("tray attach: unexpected role %q (body: %s)", raw.Role, truncate(data))
	}
	retry := 1000
	if raw.Result.RetryAfterMs != nil {
		retry = *raw.Result.RetryAfterMs
	}
	return &AttachPlan{
		Action:       raw.Result.Action,
		Code:         raw.Result.Code,
		RetryAfterMs: retry,
		Error:        raw.Result.Error,
		Bootstrap:    raw.Result.Bootstrap,
		IceServers:   raw.IceServers,
		JoinURL:      firstNonEmpty(successor, raw.Result.JoinURL),
		TrayID:       raw.TrayID,
	}, nil
}

// Poll requests pending bootstrap events.
func (c *Client) Poll(ctx context.Context, controllerID, bootstrapID string, cursor int) (*BootstrapPlan, error) {
	return c.postBootstrap(ctx, map[string]any{
		"action":       "poll",
		"controllerId": controllerID,
		"bootstrapId":  bootstrapID,
		"cursor":       cursor,
	})
}

// SendAnswer posts the follower's SDP answer.
func (c *Client) SendAnswer(ctx context.Context, controllerID, bootstrapID, answerSDP string) (*BootstrapPlan, error) {
	return c.postBootstrap(ctx, map[string]any{
		"action":       "answer",
		"controllerId": controllerID,
		"bootstrapId":  bootstrapID,
		"answer":       map[string]any{"type": "answer", "sdp": answerSDP},
	})
}

// SendICECandidate posts a local ICE candidate (fire-and-forget on the caller's side).
func (c *Client) SendICECandidate(ctx context.Context, controllerID, bootstrapID string, cand IceCandidate) (*BootstrapPlan, error) {
	candidate := map[string]any{"candidate": cand.Candidate}
	if cand.SDPMid != nil {
		candidate["sdpMid"] = *cand.SDPMid
	}
	if cand.SDPMLineIndex != nil {
		candidate["sdpMLineIndex"] = *cand.SDPMLineIndex
	}
	if cand.UsernameFragment != nil {
		candidate["usernameFragment"] = *cand.UsernameFragment
	}
	return c.postBootstrap(ctx, map[string]any{
		"action":       "ice-candidate",
		"controllerId": controllerID,
		"bootstrapId":  bootstrapID,
		"candidate":    candidate,
	})
}

// Retry mints a fresh bootstrap after a retryable failure.
func (c *Client) Retry(ctx context.Context, controllerID, bootstrapID, runtime string) (*BootstrapPlan, error) {
	return c.postBootstrap(ctx, map[string]any{
		"action":       "retry",
		"controllerId": controllerID,
		"bootstrapId":  bootstrapID,
		"runtime":      runtime,
	})
}

func (c *Client) postBootstrap(ctx context.Context, body map[string]any) (*BootstrapPlan, error) {
	data, err := c.post(ctx, body)
	if err != nil {
		return nil, err
	}
	var raw rawBootstrapResponse
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("tray bootstrap: invalid response: %w (body: %s)", err, truncate(data))
	}
	if raw.Role != "follower" {
		return nil, fmt.Errorf("tray bootstrap: unexpected role %q (body: %s)", raw.Role, truncate(data))
	}
	return &BootstrapPlan{Bootstrap: raw.Bootstrap, Events: raw.Events}, nil
}

func (c *Client) post(ctx context.Context, body map[string]any) ([]byte, error) {
	data, _, err := c.postWithMeta(ctx, body)
	return data, err
}

// networkError is a transport failure, as opposed to a request we could not
// even build. Only the former is retried.
type networkError struct{ err error }

func (e *networkError) Error() string { return "tray signaling network error: " + e.err.Error() }
func (e *networkError) Unwrap() error { return e.err }

// responseMeta is the part of a signaling response that outlives its body: the
// status and headers the supersede hop is read from (#1957).
type responseMeta struct {
	Status int
	Header http.Header
}

// postWithMeta is post plus the response status and headers, for the callers
// that read the RFC 8288 Link header and the 308 Location.
//
// A non-JSON body (Cloudflare's "error code: 1101"), a 5xx, or a network
// error is transient: the same request is repeated with backoff. A redirect
// that names a successor is returned immediately so the caller can follow it.
func (c *Client) postWithMeta(ctx context.Context, body map[string]any) ([]byte, responseMeta, error) {
	deadline := c.retryDeadline(ctx)
	backoff := signalingRetryBase
	var last error
	for attempt := 1; attempt <= signalingAttempts; attempt++ {
		if !time.Now().Before(deadline) {
			break
		}
		data, meta, err := c.postBounded(ctx, body, deadline)
		var net *networkError
		switch {
		case err == nil && !transientResponse(meta, data):
			return data, meta, nil
		case err == nil:
			last = fmt.Errorf("tray signaling: transient response: %s", describeResponse(meta.Status, data))
		case errors.As(err, &net) && ctx.Err() == nil:
			last = err
		default:
			return nil, responseMeta{}, err
		}
		// The next attempt has to fit its backoff and still have time to run.
		// A request that finished 0.5s before the deadline must not sleep 1s
		// and then hang for the 30s client timeout.
		if attempt == signalingAttempts || time.Until(deadline) <= backoff {
			break
		}
		c.logRetry(last, backoff)
		if !c.wait(ctx, backoff) {
			break
		}
		if backoff < signalingRetryMax {
			backoff *= 2
		}
	}
	if last == nil {
		last = ctx.Err()
	}
	return nil, responseMeta{}, last
}

// retryDeadline is the moment this call stops trying. The caller's deadline
// wins when it is sooner, so a bootstrap that is about to time out is not
// extended by the retry budget.
func (c *Client) retryDeadline(ctx context.Context) time.Time {
	budget := signalingRetryBudget
	if c.retryBudget > 0 {
		budget = c.retryBudget
	}
	deadline := time.Now().Add(budget)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	return deadline
}

// postBounded runs one attempt. Its deadline is the earlier of the retry
// budget and defaultRequestTimeout, so a stall cannot use the client's 30s
// timeout once less than that remains.
func (c *Client) postBounded(ctx context.Context, body map[string]any, deadline time.Time) ([]byte, responseMeta, error) {
	bound := deadline
	if capAt := time.Now().Add(defaultRequestTimeout); capAt.Before(bound) {
		bound = capAt
	}
	reqCtx, cancel := context.WithDeadline(ctx, bound)
	defer cancel()
	return c.postOnce(reqCtx, body)
}

func (c *Client) postOnce(ctx context.Context, body map[string]any) ([]byte, responseMeta, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, responseMeta{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.joinURL, bytes.NewReader(payload))
	if err != nil {
		return nil, responseMeta{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, responseMeta{}, &networkError{err: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, responseMeta{}, &networkError{err: err}
	}
	return data, responseMeta{Status: resp.StatusCode, Header: resp.Header}, nil
}

// transientResponse reports a body the follower should send again. A named
// successor is never transient: the tray moved, and retrying the old URL
// cannot finish the hop.
func transientResponse(meta responseMeta, data []byte) bool {
	if SuccessorVersionFromLinkHeader(meta.Header) != "" ||
		RedirectLocation(meta.Status, meta.Header.Get("Location")) != "" {
		return false
	}
	if meta.Status >= 500 {
		return true
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return false
	}
	return !json.Valid(trimmed)
}

func describeResponse(status int, body []byte) string {
	return fmt.Sprintf("status %d body: %s", status, truncate(body))
}

func (c *Client) logRetry(err error, backoff time.Duration) {
	if c.logf == nil {
		return
	}
	c.logf("tray signaling: %s; retrying in %s", err, backoff)
}

func (c *Client) wait(ctx context.Context, d time.Duration) bool {
	sleep := c.sleep
	if sleep == nil {
		sleep = sleepSignaling
	}
	return sleep(ctx, d)
}

func sleepSignaling(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// RedirectLocation returns the replacement join URL named by a suppressed 3xx,
// or "". The hub's Location carries json=true so that clients which let their
// platform follow the redirect still reach the API rather than the SPA fallback
// (#1957); this client re-appends what it needs, so the parameter is dropped
// rather than persisted as part of the session's join URL. A relative or
// unparseable target yields "" — a hop to an address this client had to guess
// at is worse than reporting none.
func RedirectLocation(status int, location string) string {
	if status < 300 || status >= 400 || location == "" {
		return ""
	}
	parsed, err := url.Parse(location)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return ""
	}
	query := parsed.Query()
	query.Del("json")
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func truncate(b []byte) string {
	const maxLen = 200
	if len(b) > maxLen {
		return string(b[:maxLen]) + "…"
	}
	return string(b)
}
