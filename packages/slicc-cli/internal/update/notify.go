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

// checkState is the cached result of the once-a-day release check, persisted
// at <user-cache-dir>/slicc/update-check.json. The notice itself is printed
// from THIS cache, never from a live request — so a launch is never delayed
// by the network, and a fresh result shows on the next launch.
type checkState struct {
	CheckedAt     time.Time `json:"checkedAt"`
	LatestVersion string    `json:"latestVersion"`
}

// DefaultStatePath is <os.UserCacheDir>/slicc/update-check.json.
func DefaultStatePath() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "slicc", "update-check.json"), nil
}

// Notifier prints the cached upgrade notice and refreshes the cache at most
// once per CheckInterval. Fields are injectable for tests; use NewNotifier
// for production wiring.
type Notifier struct {
	Checker       *Checker
	StatePath     string
	Out           io.Writer
	Version       string
	Now           func() time.Time
	CheckInterval time.Duration
	// RefreshWait bounds how long Flush waits for an in-flight background
	// refresh, so a short-lived command still persists the result without
	// stalling long past its own work.
	RefreshWait    time.Duration
	RefreshTimeout time.Duration
}

// NewNotifier builds the production Notifier. Returns nil (a no-op for Start)
// when the check is disabled: dev builds, SLICC_NO_UPDATE_CHECK set, or no
// resolvable cache dir.
func NewNotifier(version string, out io.Writer) *Notifier {
	if version == "dev" || os.Getenv("SLICC_NO_UPDATE_CHECK") != "" {
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
	// A corrupt state file is treated as absent.
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
	// Best-effort: a read-only cache dir just means no notice, never a failure.
	_ = os.WriteFile(n.StatePath, data, 0o600)
}

// Start prints the upgrade notice when the cached latest version is newer than
// the running one, and — at most once per CheckInterval — kicks off a
// background refresh of the cache. The returned flush func waits (bounded by
// RefreshWait) for that refresh so short commands still persist it; it never
// blocks longer. Both the receiver and the returned func are nil-safe.
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
	// Stamp CheckedAt before the fetch so overlapping launches don't stampede
	// the API; the version refresh lands when the fetch completes.
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
