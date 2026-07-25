package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// releasesStub serves one page with a single release carrying every CLI asset,
// so cmdUpdate resolves regardless of the platform the tests run on.
func releasesStub(t *testing.T, tag string) *httptest.Server {
	t.Helper()
	type asset struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	}
	assets := []asset{}
	for _, name := range []string{
		"slicc-darwin-amd64", "slicc-darwin-arm64",
		"slicc-linux-amd64", "slicc-linux-arm64",
		"slicc-windows-amd64.exe", "slicc-windows-arm64.exe",
	} {
		assets = append(assets, asset{Name: name, BrowserDownloadURL: "https://example.com/" + name})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			_, _ = w.Write([]byte("[]"))
			return
		}
		payload := []map[string]any{{"tag_name": tag, "assets": assets}}
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			t.Errorf("encoding releases: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRunUpdateDispatch(t *testing.T) {
	// Argument errors and --help return before any network access.
	if got := run([]string{"update", "--bogus"}); got != 2 {
		t.Fatalf("run(update --bogus) = %d, want 2", got)
	}
	if got := run([]string{"update", "--help"}); got != 0 {
		t.Fatalf("run(update --help) = %d, want 0", got)
	}
}

func TestUpdateCheckReportsOnDevBuild(t *testing.T) {
	server := releasesStub(t, "v99.0.0")
	t.Setenv("SLICC_UPDATE_API_BASE", server.URL)

	// version is "dev" in tests — not a release version, so --check reports
	// the latest release as not-comparable without touching the executable.
	if got := run([]string{"update", "--check"}); got != 0 {
		t.Fatalf("run(update --check) = %d, want 0", got)
	}
}

func TestUpdateRefusesToReplaceDevBuild(t *testing.T) {
	// A dev/git-describe build must never be silently replaced by a release
	// binary (its numeric segments read older than the tag it is ahead of).
	server := releasesStub(t, "v99.0.0")
	t.Setenv("SLICC_UPDATE_API_BASE", server.URL)

	if got := run([]string{"update"}); got != 1 {
		t.Fatalf("run(update) = %d, want 1 (refuse to replace dev build)", got)
	}
}

func TestUpdateSurfacesResolutionErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "rate limited", http.StatusForbidden)
	}))
	t.Cleanup(server.Close)
	t.Setenv("SLICC_UPDATE_API_BASE", server.URL)

	if got := run([]string{"update"}); got != 1 {
		t.Fatalf("run(update) = %d, want 1 on API failure", got)
	}
}
