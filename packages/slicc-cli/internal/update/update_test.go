package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestAssetName(t *testing.T) {
	cases := []struct {
		goos, goarch, want string
	}{
		{"darwin", "arm64", "slicc-darwin-arm64"},
		{"darwin", "amd64", "slicc-darwin-amd64"},
		{"linux", "amd64", "slicc-linux-amd64"},
		{"windows", "amd64", "slicc-windows-amd64.exe"},
		{"windows", "arm64", "slicc-windows-arm64.exe"},
	}
	for _, tc := range cases {
		if got := AssetName(tc.goos, tc.goarch); got != tc.want {
			t.Errorf("AssetName(%q, %q) = %q, want %q", tc.goos, tc.goarch, got, tc.want)
		}
	}
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v5.72.0", "v5.71.1", true},
		{"v5.71.1", "v5.71.1", false},
		{"v5.71.0", "v5.71.1", false},
		{"5.72.0", "v5.71.1", true},
		{"v6.0.0", "v5.99.99", true},
		{"v5.71.1.1", "v5.71.1", true},
		{"v5.71.1", "dev", true},
		{"dev", "v5.71.1", false},
		{"", "", false},
	}
	for _, tc := range cases {
		if got := IsNewer(tc.latest, tc.current); got != tc.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

type fakeRelease struct {
	Draft      bool        `json:"draft"`
	Prerelease bool        `json:"prerelease"`
	TagName    string      `json:"tag_name"`
	Assets     []fakeAsset `json:"assets"`
}

type fakeAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func carrier(tag, assetName, url string) fakeRelease {
	return fakeRelease{TagName: tag, Assets: []fakeAsset{{Name: assetName, BrowserDownloadURL: url}}}
}

func binaryless(tag string) fakeRelease {
	return fakeRelease{TagName: tag, Assets: []fakeAsset{{Name: "sliccy-1.0.0.tgz", BrowserDownloadURL: "x"}}}
}

// releasesServer serves canned per-page release lists and counts requests.
func releasesServer(t *testing.T, pages map[int][]fakeRelease) (*httptest.Server, *int) {
	t.Helper()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		releases := pages[page]
		if releases == nil {
			releases = []fakeRelease{}
		}
		if err := json.NewEncoder(w).Encode(releases); err != nil {
			t.Errorf("encoding releases: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	return server, &requests
}

func testChecker(server *httptest.Server) *Checker {
	return &Checker{
		APIBase: server.URL,
		HTTP:    server.Client(),
		GOOS:    "darwin",
		GOARCH:  "arm64",
		Verify:  func(context.Context, string) error { return nil },
	}
}

func TestLatestCLIReleaseSkipsSparseDraftAndPrerelease(t *testing.T) {
	server, requests := releasesServer(t, map[int][]fakeRelease{
		1: {
			binaryless("v5.72.0"),
			{Draft: true, TagName: "v5.71.9", Assets: []fakeAsset{{Name: "slicc-darwin-arm64", BrowserDownloadURL: "draft"}}},
			{Prerelease: true, TagName: "v5.71.8", Assets: []fakeAsset{{Name: "slicc-darwin-arm64", BrowserDownloadURL: "pre"}}},
			carrier("v5.71.1", "slicc-darwin-arm64", "https://example.com/slicc-darwin-arm64"),
		},
	})
	release, err := testChecker(server).LatestCLIRelease(context.Background())
	if err != nil {
		t.Fatalf("LatestCLIRelease: %v", err)
	}
	if release.Version != "v5.71.1" || release.AssetURL != "https://example.com/slicc-darwin-arm64" {
		t.Fatalf("got %+v", release)
	}
	if *requests != 1 {
		t.Fatalf("requests = %d, want 1", *requests)
	}
}

func fullBinarylessPage() []fakeRelease {
	page := make([]fakeRelease, releasesPerPage)
	for i := range page {
		page[i] = binaryless(fmt.Sprintf("v5.%d.0", i))
	}
	return page
}

func TestLatestCLIReleasePaginates(t *testing.T) {
	server, requests := releasesServer(t, map[int][]fakeRelease{
		1: fullBinarylessPage(),
		2: {carrier("v5.60.0", "slicc-darwin-arm64", "https://example.com/asset")},
	})
	release, err := testChecker(server).LatestCLIRelease(context.Background())
	if err != nil {
		t.Fatalf("LatestCLIRelease: %v", err)
	}
	if release.Version != "v5.60.0" {
		t.Fatalf("version = %q", release.Version)
	}
	if *requests != 2 {
		t.Fatalf("requests = %d, want 2", *requests)
	}
}

func TestLatestCLIReleaseStopsAtShortPage(t *testing.T) {
	server, requests := releasesServer(t, map[int][]fakeRelease{
		1: {binaryless("v5.72.0")},
	})
	if _, err := testChecker(server).LatestCLIRelease(context.Background()); err == nil {
		t.Fatal("want error when no release carries the asset")
	}
	if *requests != 1 {
		t.Fatalf("requests = %d, want 1 (short page ends pagination)", *requests)
	}
}

func TestLatestCLIReleasePageCap(t *testing.T) {
	pages := map[int][]fakeRelease{}
	for page := 1; page <= 10; page++ {
		pages[page] = fullBinarylessPage()
	}
	server, requests := releasesServer(t, pages)
	if _, err := testChecker(server).LatestCLIRelease(context.Background()); err == nil {
		t.Fatal("want error after the page cap")
	}
	if *requests != maxReleasePages {
		t.Fatalf("requests = %d, want %d", *requests, maxReleasePages)
	}
}

func TestLatestCLIReleaseAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "rate limited", http.StatusForbidden)
	}))
	t.Cleanup(server.Close)
	if _, err := testChecker(server).LatestCLIRelease(context.Background()); err == nil {
		t.Fatal("want error on non-200 API response")
	}
}

// assetServer serves a fake binary body at /asset.
func assetServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func applyFixture(t *testing.T, server *httptest.Server) (checker *Checker, exePath string, release *Release) {
	t.Helper()
	dir := t.TempDir()
	exePath = filepath.Join(dir, "slicc")
	if err := os.WriteFile(exePath, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	checker = &Checker{
		HTTP:   server.Client(),
		GOOS:   "darwin",
		GOARCH: "arm64",
		Verify: func(context.Context, string) error { return nil },
	}
	release = &Release{Version: "v9.9.9", AssetURL: server.URL + "/asset"}
	return checker, exePath, release
}

func TestApplyReplacesExecutable(t *testing.T) {
	server := assetServer(t, "new-binary", http.StatusOK)
	checker, exePath, release := applyFixture(t, server)
	verified := ""
	checker.Verify = func(_ context.Context, path string) error {
		verified = path
		return nil
	}

	if err := checker.Apply(context.Background(), release, exePath); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	content, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new-binary" {
		t.Fatalf("executable content = %q", content)
	}
	if verified != exePath+".new" {
		t.Fatalf("Verify ran on %q, want the staged file", verified)
	}
	if _, err := os.Stat(exePath + ".new"); !os.IsNotExist(err) {
		t.Fatal("staging file left behind")
	}
	info, err := os.Stat(exePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatal("executable bit lost")
	}
}

func TestApplyWindowsParksOldBinary(t *testing.T) {
	server := assetServer(t, "new-binary", http.StatusOK)
	checker, exePath, release := applyFixture(t, server)
	checker.GOOS = "windows"

	if err := checker.Apply(context.Background(), release, exePath); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	parked, err := os.ReadFile(exePath + ".old")
	if err != nil {
		t.Fatalf("parked binary missing: %v", err)
	}
	if string(parked) != "old-binary" {
		t.Fatalf("parked content = %q", parked)
	}
	current, _ := os.ReadFile(exePath)
	if string(current) != "new-binary" {
		t.Fatalf("executable content = %q", current)
	}

	RemoveStaleBinary(exePath)
	if _, err := os.Stat(exePath + ".old"); !os.IsNotExist(err) {
		t.Fatal("RemoveStaleBinary left the .old binary")
	}
}

func TestApplyVerifyFailureKeepsOldBinary(t *testing.T) {
	server := assetServer(t, "corrupt", http.StatusOK)
	checker, exePath, release := applyFixture(t, server)
	checker.Verify = func(context.Context, string) error { return fmt.Errorf("does not run") }

	if err := checker.Apply(context.Background(), release, exePath); err == nil {
		t.Fatal("want error when verification fails")
	}
	content, _ := os.ReadFile(exePath)
	if string(content) != "old-binary" {
		t.Fatalf("executable content = %q, want untouched old binary", content)
	}
	if _, err := os.Stat(exePath + ".new"); !os.IsNotExist(err) {
		t.Fatal("staging file left behind")
	}
}

func TestApplyDownloadErrorKeepsOldBinary(t *testing.T) {
	server := assetServer(t, "not found", http.StatusNotFound)
	checker, exePath, release := applyFixture(t, server)

	if err := checker.Apply(context.Background(), release, exePath); err == nil {
		t.Fatal("want error on HTTP 404 download")
	}
	content, _ := os.ReadFile(exePath)
	if string(content) != "old-binary" {
		t.Fatalf("executable content = %q", content)
	}
}

func TestApplyEmptyDownloadRejected(t *testing.T) {
	server := assetServer(t, "", http.StatusOK)
	checker, exePath, release := applyFixture(t, server)

	if err := checker.Apply(context.Background(), release, exePath); err == nil {
		t.Fatal("want error on empty download")
	}
	if _, err := os.Stat(exePath + ".new"); !os.IsNotExist(err) {
		t.Fatal("staging file left behind")
	}
}
