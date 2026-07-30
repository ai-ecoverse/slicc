package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/cloud"
)

// withCloudList swaps the cloud lister seam for the duration of a test.
func withCloudList(t *testing.T, fake func(bool) ([]cloud.Session, error)) {
	t.Helper()
	prev := cloudList
	cloudList = fake
	t.Cleanup(func() { cloudList = prev })
}

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()
	fn()
	_ = w.Close()
	os.Stdout = prev
	return <-done
}

func sample() []cloud.Session {
	return []cloud.Session{
		{ID: "aaa11122233", Label: "Chrome", DeviceName: "MacA", LastSeenAt: time.Now().Add(-2 * time.Minute), JoinURL: "https://slicc.test/join/a.secret"},
		{ID: "bbb44455566", Label: "Edge", DeviceName: "MacB", LastSeenAt: time.Now().Add(-30 * time.Minute), JoinURL: "https://slicc.test/join/b.secret"},
	}
}

func TestCmdListSessionsTable(t *testing.T) {
	withCloudList(t, func(reveal bool) ([]cloud.Session, error) {
		if reveal {
			t.Error("list-sessions must not request reveal")
		}
		return sample(), nil
	})
	out := captureStdout(t, func() {
		if code := cmdListSessions(nil); code != 0 {
			t.Errorf("exit code = %d", code)
		}
	})
	if !strings.Contains(out, "Chrome") || !strings.Contains(out, "MacB") {
		t.Errorf("table missing rows: %q", out)
	}
	if strings.Contains(out, "secret") {
		t.Errorf("join URL leaked into table: %q", out)
	}
}

func TestCmdListSessionsJSON(t *testing.T) {
	withCloudList(t, func(bool) ([]cloud.Session, error) { return sample(), nil })
	out := captureStdout(t, func() {
		if code := cmdListSessions([]string{"--json"}); code != 0 {
			t.Errorf("exit code = %d", code)
		}
	})
	if !strings.Contains(out, `"label": "Chrome"`) {
		t.Errorf("json output unexpected: %q", out)
	}
}

func TestCmdListSessionsError(t *testing.T) {
	withCloudList(t, func(bool) ([]cloud.Session, error) { return nil, cloud.ErrUnsupported })
	if code := cmdListSessions(nil); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestCmdListSessionsUnknownOption(t *testing.T) {
	if code := cmdListSessions([]string{"--nope"}); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}

func TestResolveCloudSession(t *testing.T) {
	got, err := resolveCloudSession(true, cloud.Selector{Index: 0}, func(reveal bool) ([]cloud.Session, error) {
		if !reveal {
			t.Error("cloud verbs must request reveal")
		}
		return sample(), nil
	})
	if err != nil {
		t.Fatalf("resolveCloudSession: %v", err)
	}
	if got.ID != "aaa11122233" {
		t.Errorf("expected newest session, got %q", got.ID)
	}
}

func TestResolveCloudSessionListError(t *testing.T) {
	_, err := resolveCloudSession(true, cloud.Selector{}, func(bool) ([]cloud.Session, error) {
		return nil, errors.New("boom")
	})
	if err == nil {
		t.Fatal("expected list error to propagate")
	}
}

func TestCmdCloudListErrorShortCircuits(t *testing.T) {
	// A list error must return before any WebRTC dial is attempted.
	withCloudList(t, func(bool) ([]cloud.Session, error) { return nil, cloud.ErrUnsupported })
	if code := cmdCloud(context.Background(), "follow-cloud", nil); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestCmdCloudBadSelector(t *testing.T) {
	if code := cmdCloud(context.Background(), "follow-cloud", []string{"--index", "notnum"}); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}

func TestCmdCloudMissingJoinURL(t *testing.T) {
	withCloudList(t, func(bool) ([]cloud.Session, error) {
		return []cloud.Session{{ID: "x", LastSeenAt: time.Now()}}, nil // no JoinURL (reveal denied)
	})
	if code := cmdCloud(context.Background(), "prompt-cloud", []string{"hello"}); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestCmdCloudPromptMissingText(t *testing.T) {
	withCloudList(t, func(bool) ([]cloud.Session, error) { return sample(), nil })
	if code := cmdCloud(context.Background(), "prompt-cloud", nil); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}

func TestCmdCloudExecMissingCommand(t *testing.T) {
	withCloudList(t, func(bool) ([]cloud.Session, error) { return sample(), nil })
	if code := cmdCloud(context.Background(), "exec-cloud", nil); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}

func TestCmdCloudUnknownVerb(t *testing.T) {
	withCloudList(t, func(bool) ([]cloud.Session, error) { return sample(), nil })
	if code := cmdCloud(context.Background(), "bogus-cloud", nil); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}
