package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type checkState struct {
	CheckedAt     time.Time `json:"checkedAt"`
	LatestVersion string    `json:"latestVersion"`
}

func DefaultStatePath() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "slicc", "update-check.json"), nil
}

type Notifier struct {
	Checker       *Checker
	StatePath     string
	Out           io.Writer
	Version       string
	Now           func() time.Time
	CheckInterval time.Duration

	RefreshWait    time.Duration
	RefreshTimeout time.Duration
}

func NewNotifier(version string, out io.Writer) *Notifier {
	if !IsReleaseVersion(version) || os.Getenv("SLICC_NO_UPDATE_CHECK") != "" {
		return nil
	}
	statePath, err := DefaultStatePath()
	if err != nil {
		return nil
	}
	return &Notifier{
		Checker:        NewChecker(),
		StatePath:      statePath,
		Out:            out,
		Version:        version,
		Now:            time.Now,
		CheckInterval:  24 * time.Hour,
		RefreshWait:    3 * time.Second,
		RefreshTimeout: 10 * time.Second,
	}
}

func (n *Notifier) readState() checkState {
	var state checkState
	data, err := os.ReadFile(n.StatePath)
	if err != nil {
		return state
	}

	_ = json.Unmarshal(data, &state)
	return state
}

func (n *Notifier) writeState(state checkState) {
	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(n.StatePath), 0o755); err != nil {
		return
	}

	_ = os.WriteFile(n.StatePath, data, 0o600)
}

func (n *Notifier) Start() func() {
	noop := func() {}
	if n == nil {
		return noop
	}
	state := n.readState()
	if n.Out != nil && state.LatestVersion != "" && IsNewer(state.LatestVersion, n.Version) {
		fmt.Fprintf(n.Out, "slicc %s is available (you have %s) — run `slicc update`\n",
			state.LatestVersion, n.Version)
	}
	if n.Now().Sub(state.CheckedAt) < n.CheckInterval {
		return noop
	}

	n.writeState(checkState{CheckedAt: n.Now(), LatestVersion: state.LatestVersion})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), n.RefreshTimeout)
		defer cancel()
		release, err := n.Checker.LatestCLIRelease(ctx)
		if err != nil {
			return
		}
		n.writeState(checkState{CheckedAt: n.Now(), LatestVersion: release.Version})
	}()
	return func() {
		select {
		case <-done:
		case <-time.After(n.RefreshWait):
		}
	}
}
