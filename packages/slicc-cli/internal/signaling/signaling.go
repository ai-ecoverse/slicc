






package signaling

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)





const defaultRequestTimeout = 30 * time.Second


type TurnIceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}


type SessionDescription struct {
	Type string `json:"type"` 
	SDP  string `json:"sdp"`
}


type IceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}


type BootstrapFailure struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Retryable  bool   `json:"retryable"`
	RetryAfter *int   `json:"retryAfterMs"`
	FailedAt   string `json:"failedAt"`
}


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


type BootstrapEvent struct {
	Sequence  int                 `json:"sequence"`
	SentAt    string              `json:"sentAt"`
	Type      string              `json:"type"` 
	Offer     *SessionDescription `json:"offer,omitempty"`
	Candidate *IceCandidate       `json:"candidate,omitempty"`
	Failure   *BootstrapFailure   `json:"failure,omitempty"`
}


type AttachPlan struct {
	Action       string 
	Code         string
	RetryAfterMs int
	Error        string
	Bootstrap    *BootstrapStatus
	IceServers   []TurnIceServer
	
	
	
	JoinURL string
	TrayID  string
}


type BootstrapPlan struct {
	Bootstrap BootstrapStatus
	Events    []BootstrapEvent
}


type Client struct {
	joinURL string
	http    *http.Client
}









func New(joinURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultRequestTimeout}
	}
	client := *httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{joinURL: joinURL, http: &client}
}


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


func (c *Client) Attach(ctx context.Context, controllerID, runtime string) (*AttachPlan, error) {
	body := map[string]any{"controllerId": controllerID, "runtime": runtime}
	data, meta, err := c.postWithMeta(ctx, body)
	if err != nil {
		return nil, err
	}
	
	
	
	
	
	
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


func (c *Client) Poll(ctx context.Context, controllerID, bootstrapID string, cursor int) (*BootstrapPlan, error) {
	return c.postBootstrap(ctx, map[string]any{
		"action":       "poll",
		"controllerId": controllerID,
		"bootstrapId":  bootstrapID,
		"cursor":       cursor,
	})
}


func (c *Client) SendAnswer(ctx context.Context, controllerID, bootstrapID, answerSDP string) (*BootstrapPlan, error) {
	return c.postBootstrap(ctx, map[string]any{
		"action":       "answer",
		"controllerId": controllerID,
		"bootstrapId":  bootstrapID,
		"answer":       map[string]any{"type": "answer", "sdp": answerSDP},
	})
}


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



type responseMeta struct {
	Status int
	Header http.Header
}



func (c *Client) postWithMeta(ctx context.Context, body map[string]any) ([]byte, responseMeta, error) {
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
		return nil, responseMeta{}, fmt.Errorf("tray signaling network error: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, responseMeta{}, err
	}
	return data, responseMeta{Status: resp.StatusCode, Header: resp.Header}, nil
}








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
