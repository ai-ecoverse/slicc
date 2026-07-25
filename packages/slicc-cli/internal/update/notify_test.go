package update

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testNotifier(t *testing.T, server serverHandle, now time.Time) (*Notifier, *bytes.Buffer) {
	t.Helper()
	out := &bytes.Buffer{}
	notifier := &Notifier{
		Checker:        testChecker(server.server),
		StatePath:      filepath.Join(t.TempDir(), "update-check.json"),
		Out:            out,
		Version:        "v5.71.1",
		Now:            func() time.Time { return now },
		CheckInterval:  24 * time.Hour,
		RefreshWait:    5 * time.Second,
		RefreshTimeout: 5 * time.Second,
	}
	return notifier, out
}

type serverHandle struct {
	server   *httptest.Server
	requests *int
}

func newReleasesHandle(t *testing.T, tag string) serverHandle {
	server, requests := releasesServer(t, map[int][]fakeRelease{
		1: {carrier(tag, "slicc-darwin-arm64", "https://example.com/asset")},
	})
	return serverHandle{server: server, requests: requests}
}

func readStateFile(t *testing.T, path string) checkState {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading state: %v", err)
	}
	var state checkState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("parsing state: %v", err)
	}
	return state
}

func TestNotifierFirstRunRefreshesCacheWithoutNotice(t *testing.T) {
	handle := newReleasesHandle(t, "v9.9.9")
	notifier, out := testNotifier(t, handle, time.Now())

	flush := notifier.Start()
	flush()

	if out.Len() != 0 {
		t.Fatalf("first run printed %q, want silence (notice comes from cache)", out.String())
	}
	state := readStateFile(t, notifier.StatePath)
	if state.LatestVersion != "v9.9.9" {
		t.Fatalf("cached latest = %q, want v9.9.9", state.LatestVersion)
	}
	if *handle.requests != 1 {
		t.Fatalf("requests = %d, want 1", *handle.requests)
	}
}

func TestNotifierPrintsCachedNoticeAndSkipsFreshCheck(t *testing.T) {
	handle := newReleasesHandle(t, "v9.9.9")
	now := time.Now()
	notifier, out := testNotifier(t, handle, now)

	// Seed the cache as a recent check that saw a newer version.
	notifier.writeState(checkState{CheckedAt: now.Add(-time.Hour), LatestVersion: "v9.9.9"})

	flush := notifier.Start()
	flush()

	if !strings.Contains(out.String(), "v9.9.9 is available") {
		t.Fatalf("notice missing from %q", out.String())
	}
	if !strings.Contains(out.String(), "slicc update") {
		t.Fatalf("notice does not point at `slicc update`: %q", out.String())
	}
	if *handle.requests != 0 {
		t.Fatalf("requests = %d, want 0 (checked an hour ago)", *handle.requests)
	}
}

func TestNotifierRefreshesAfterInterval(t *testing.T) {
	handle := newReleasesHandle(t, "v9.9.9")
	now := time.Now()
	notifier, _ := testNotifier(t, handle, now)
	notifier.writeState(checkState{CheckedAt: now.Add(-25 * time.Hour), LatestVersion: ""})

	flush := notifier.Start()
	flush()

	if *handle.requests != 1 {
		t.Fatalf("requests = %d, want 1 (interval elapsed)", *handle.requests)
	}
	if got := readStateFile(t, notifier.StatePath).LatestVersion; got != "v9.9.9" {
		t.Fatalf("cached latest = %q", got)
	}
}

func TestNotifierUpToDateStaysQuiet(t *testing.T) {
	handle := newReleasesHandle(t, "v5.71.1")
	now := time.Now()
	notifier, out := testNotifier(t, handle, now)
	notifier.writeState(checkState{CheckedAt: now.Add(-time.Hour), LatestVersion: "v5.71.1"})

	notifier.Start()()

	if out.Len() != 0 {
		t.Fatalf("printed %q for an up-to-date binary", out.String())
	}
}

func TestNotifierToleratesCorruptStateFile(t *testing.T) {
	handle := newReleasesHandle(t, "v9.9.9")
	notifier, out := testNotifier(t, handle, time.Now())
	if err := os.WriteFile(notifier.StatePath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	notifier.Start()()

	if out.Len() != 0 {
		t.Fatalf("printed %q from a corrupt state file", out.String())
	}
	if got := readStateFile(t, notifier.StatePath).LatestVersion; got != "v9.9.9" {
		t.Fatalf("cache not refreshed after corrupt state, latest = %q", got)
	}
}

func TestNilNotifierIsSafe(_ *testing.T) {
	var notifier *Notifier
	notifier.Start()() // must not panic
}

func TestNewNotifierDisabledForDevAndOptOut(t *testing.T) {
	if NewNotifier("dev", os.Stderr) != nil {
		t.Fatal("dev builds must not check for updates")
	}
	if NewNotifier("v5.71.1-4-gabc123-dirty", os.Stderr) != nil {
		t.Fatal("git-describe builds must not check for updates")
	}
	t.Setenv("SLICC_NO_UPDATE_CHECK", "1")
	if NewNotifier("v5.71.1", os.Stderr) != nil {
		t.Fatal("SLICC_NO_UPDATE_CHECK must disable the check")
	}
}
