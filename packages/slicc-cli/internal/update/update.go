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
	releasesPerPage = 100

	maxReleasePages = 5
	userAgent       = "slicc-cli"
)

type Release struct {
	Version  string
	AssetURL string
}

type Checker struct {
	APIBase string
	HTTP    *http.Client
	GOOS    string
	GOARCH  string

	Verify func(ctx context.Context, path string) error
}

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

		if len(releases) < releasesPerPage {
			break
		}
	}
	return nil, fmt.Errorf("no recent release carries %s (CLI binaries only attach to releases where packages/slicc-cli changed)", asset)
}

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

		if parked {
			_ = renameFile(exePath+".old", exePath)
		}
		_ = os.Remove(staging)
		return err
	}
	return nil
}

func RemoveStaleBinary(exePath string) {
	_ = os.Remove(exePath + ".old")
}
