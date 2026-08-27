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
	"fmt"
	"io"
	"net/http"
	"time"
)

// defaultRequestTimeout bounds each signaling HTTP request. http.DefaultClient
// has no timeout, so without this a server that accepts the connection and never
// replies would hang attach/poll forever (the bootstrap deadline is only checked
// between requests).
const defaultRequestTimeout = 30 * time.Second

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
}

// New builds a signaling client for the given join URL.
func New(joinURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultRequestTimeout}
	}
	return &Client{joinURL: joinURL, http: httpClient}
}

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
	data, header, err := c.postWithHeader(ctx, body)
	if err != nil {
		return nil, err
	}
	// #1957: a superseded tray states the replacement twice — in the body, and
	// as an RFC 5829 `successor-version` link. The header is the channel that
	// survives a body-shape change, so it wins when both are present, and it
	// alone is enough to follow the hop: a body this build cannot decode is
	// not a dead end when the hub told us where the tray went.
	successor := SuccessorVersionFromLinkHeader(header)
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
	data, _, err := c.postWithHeader(ctx, body)
	return data, err
}

// postWithHeader is post plus the response headers, for the callers that read
// the RFC 8288 Link header (the `successor-version` supersede hop, #1957).
func (c *Client) postWithHeader(ctx context.Context, body map[string]any) ([]byte, http.Header, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.joinURL, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("tray signaling network error: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, nil, err
	}
	return data, resp.Header, nil
}

func truncate(b []byte) string {
	const maxLen = 200
	if len(b) > maxLen {
		return string(b[:maxLen]) + "…"
	}
	return string(b)
}
