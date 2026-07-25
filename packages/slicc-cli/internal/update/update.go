// Package update finds, downloads, and applies newer slicc CLI release
// binaries, and backs the once-a-day upgrade notice printed on launch.
//
// Release binaries are sparse: they only attach to GitHub releases where
// packages/slicc-cli changed (release-native.mjs gating), so discovery scans
// releases newest→oldest for the first one carrying this platform's
// slicc-<os>-<arch>[.exe] asset — the same bounded pagination the tray hub
// worker uses for /download/slicc.dmg and /download/slicc-cli/:target.
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIBase  = "https://api.github.com"
	repoPath        = "ai-ecoverse/slicc"
	releasesPerPage = 30
	// Bounded pagination: 5 × 30 releases scanned before giving up, so a long
	// streak of binary-less releases cannot drive unbounded GitHub API calls.
	maxReleasePages = 5
	userAgent       = "slicc-cli"
)

// Release is the newest release that carries this platform's CLI binary.
type Release struct {
	Version  string // tag name, e.g. "v5.71.1"
	AssetURL string
}

// Checker resolves and downloads CLI release binaries. The zero value is not
// usable; construct with NewChecker.
type Checker struct {
	APIBase string
	HTTP    *http.Client
	GOOS    string
	GOARCH  string
	// Verify is run on the staged binary before it replaces the executable
	// (default: exec `<staged> --version`). Injectable for tests, where the
	// staged download is not a runnable binary.
	Verify func(ctx context.Context, path string) error
}

// NewChecker builds a production Checker. SLICC_UPDATE_API_BASE overrides the
// GitHub API base URL (tests, mirrors).
func NewChecker() *Checker {
	base := os.Getenv("SLICC_UPDATE_API_BASE")
	if base == "" {
		base = defaultAPIBase
	}
	return &Checker{
		APIBase: base,
		HTTP:    &http.Client{Timeout: 60 * time.Second},
		GOOS:    runtime.GOOS,
		GOARCH:  runtime.GOARCH,
		Verify:  runVersionCheck,
	}
}

// AssetName is the release-asset name for a GOOS/GOARCH pair, mirroring the
// Makefile dist matrix (slicc-<os>-<arch>, ".exe" on windows).
func AssetName(goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("slicc-%s-%s%s", goos, goarch, ext)
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type githubRelease struct {
	Draft      bool          `json:"draft"`
	Prerelease bool          `json:"prerelease"`
	TagName    string        `json:"tag_name"`
	Assets     []githubAsset `json:"assets"`
}

func (c *Checker) fetchReleasesPage(ctx context.Context, page int) ([]githubRelease, error) {
	url := fmt.Sprintf("%s/repos/%s/releases?per_page=%d&page=%d", c.APIBase, repoPath, releasesPerPage, page)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub releases API responded %d", res.StatusCode)
	}
	var releases []githubRelease
	if err := json.NewDecoder(res.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("decoding GitHub releases: %w", err)
	}
	return releases, nil
}

// LatestCLIRelease scans releases newest→oldest for the first published one
// carrying this platform's CLI asset.
func (c *Checker) LatestCLIRelease(ctx context.Context) (*Release, error) {
	asset := AssetName(c.GOOS, c.GOARCH)
	for page := 1; page <= maxReleasePages; page++ {
		releases, err := c.fetchReleasesPage(ctx, page)
		if err != nil {
			return nil, err
		}
		if len(releases) == 0 {
			break
		}
		for _, release := range releases {
			if release.Draft || release.Prerelease {
				continue
			}
			for _, candidate := range release.Assets {
				if candidate.Name == asset && candidate.BrowserDownloadURL != "" {
					return &Release{Version: release.TagName, AssetURL: candidate.BrowserDownloadURL}, nil
				}
			}
		}
		// Fewer than a full page means the last page — stop early.
		if len(releases) < releasesPerPage {
			break
		}
	}
	return nil, fmt.Errorf("no recent release carries %s (CLI binaries only attach to releases where packages/slicc-cli changed)", asset)
}

// IsReleaseVersion reports whether v looks like a stamped release version
// (`v5.71.1` / `5.71.1`). Local builds stamp `git describe` output —
// `v5.71.1-4-gabc123`, a bare hash, "dev", or a `-dirty` suffix — which must
// never be compared against releases: segment-wise they read OLDER than the
// tag they are ahead of, so an update would replace newer local code.
func IsReleaseVersion(v string) bool {
	trimmed := strings.TrimPrefix(strings.TrimSpace(v), "v")
	if trimmed == "" {
		return false
	}
	for _, part := range strings.Split(trimmed, ".") {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

// IsNewer reports whether version `latest` is strictly newer than `current`.
// A leading "v" is tolerated; non-numeric segments count as 0, so a "dev"
// current always reads as older than a real release.
func IsNewer(latest, current string) bool {
	parse := func(v string) []int {
		parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
		nums := make([]int, len(parts))
		for i, part := range parts {
			n, err := strconv.Atoi(part)
			if err == nil {
				nums[i] = n
			}
		}
		return nums
	}
	a, b := parse(latest), parse(current)
	for i := 0; i < len(a) || i < len(b); i++ {
		av, bv := 0, 0
		if i < len(a) {
			av = a[i]
		}
		if i < len(b) {
			bv = b[i]
		}
		if av != bv {
			return av > bv
		}
	}
	return false
}

// renameFile is os.Rename, indirected so tests can fail the final swap and
// exercise the Windows rollback path.
var renameFile = os.Rename

func runVersionCheck(ctx context.Context, path string) error {
	if err := exec.CommandContext(ctx, path, "--version").Run(); err != nil {
		return fmt.Errorf("downloaded binary failed to run --version: %w", err)
	}
	return nil
}

func (c *Checker) downloadTo(ctx context.Context, url, destination string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed with HTTP %d for %s", res.StatusCode, url)
	}
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(out, res.Body)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written == 0 {
		return fmt.Errorf("download of %s produced an empty file", url)
	}
	return nil
}

// Apply downloads the release binary next to exePath, verifies it runs, and
// atomically swaps it in. On Windows the running executable cannot be
// overwritten, but it CAN be renamed — the old binary is parked at
// exePath+".old" (removed by RemoveStaleBinary on a later run).
func (c *Checker) Apply(ctx context.Context, release *Release, exePath string) error {
	staging := exePath + ".new"
	if err := c.downloadTo(ctx, release.AssetURL, staging); err != nil {
		_ = os.Remove(staging)
		return err
	}
	if err := c.Verify(ctx, staging); err != nil {
		_ = os.Remove(staging)
		return err
	}
	parked := false
	if c.GOOS == "windows" {
		old := exePath + ".old"
		_ = os.Remove(old)
		if err := renameFile(exePath, old); err != nil {
			_ = os.Remove(staging)
			return fmt.Errorf("parking the running executable: %w", err)
		}
		parked = true
	}
	if err := renameFile(staging, exePath); err != nil {
		// Roll the parked executable back so a failed swap never leaves the
		// install path empty (e.g. antivirus locking the staged file).
		if parked {
			_ = renameFile(exePath+".old", exePath)
		}
		_ = os.Remove(staging)
		return err
	}
	return nil
}

// RemoveStaleBinary clears the ".old" binary a Windows self-update parks next
// to the executable. Best-effort; safe to call on every launch.
func RemoveStaleBinary(exePath string) {
	_ = os.Remove(exePath + ".old")
}
