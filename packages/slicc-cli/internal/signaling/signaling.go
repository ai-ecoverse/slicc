






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





const defaultRequestTimeout = 30 * time.Second








const (
	signalingAttempts    = 4
	signalingRetryBase   = time.Second
	signalingRetryMax    = 4 * time.Second
	signalingRetryBudget = 8 * time.Second
)


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
	logf    func(string, ...any)
	
	sleep func(context.Context, time.Duration) bool
	
	
	retryBudget time.Duration
}









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



func (c *Client) SetLogf(fn func(string, ...any)) { c.logf = fn }


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



type networkError struct{ err error }

func (e *networkError) Error() string { return "tray signaling network error: " + e.err.Error() }
func (e *networkError) Unwrap() error { return e.err }



type responseMeta struct {
	Status int
	Header http.Header
}







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
