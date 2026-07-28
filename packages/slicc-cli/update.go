package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ai-ecoverse/slicc-cli/internal/update"
)

// cmdUpdate implements `slicc update [--check]`: find the newest release
// carrying this platform's CLI binary (releases are sparse — binaries only
// attach when packages/slicc-cli changed) and replace the running executable
// with it. `--check` reports without installing.
func cmdUpdate(ctx context.Context, args []string) int {
	checkOnly := false
	for _, arg := range args {
		switch arg {
		case "--check":
			checkOnly = true
		case "-h", "--help":
			usage(os.Stdout)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "slicc update: unknown argument %q\n", arg)
			return 2
		}
	}

	checker := update.NewChecker()
	release, err := checker.LatestCLIRelease(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc update: %s\n", err)
		reportRuntimeError("update", err)
		return 1
	}
	// A git-describe / dev build is not comparable to release tags (its
	// numeric segments read OLDER than the tag it is ahead of), so never
	// silently replace it with a release binary.
	if !update.IsReleaseVersion(version) {
		if checkOnly {
			fmt.Printf("latest CLI release: %s (you run a development build, %s — not comparable)\n", release.Version, version)
			return 0
		}
		fmt.Fprintf(os.Stderr, "slicc update: refusing to replace a development build (%s) with release %s — rebuild with `make build`, or download the release binary explicitly\n", version, release.Version)
		return 1
	}
	if !update.IsNewer(release.Version, version) {
		fmt.Printf("slicc %s is up to date (latest CLI release: %s)\n", version, release.Version)
		return 0
	}
	if checkOnly {
		fmt.Printf("slicc %s is available (you have %s) — run `slicc update`\n", release.Version, version)
		return 0
	}

	exePath, err := executablePath()
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc update: locating the running executable: %s\n", err)
		return 1
	}
	fmt.Printf("updating slicc %s → %s ...\n", version, release.Version)
	if err := checker.Apply(ctx, release, exePath); err != nil {
		fmt.Fprintf(os.Stderr, "slicc update: %s\n", err)
		reportRuntimeError("update", err)
		return 1
	}
	fmt.Printf("updated %s to slicc %s\n", exePath, release.Version)
	return 0
}

// executablePath resolves the running binary with symlinks flattened, so an
// update through a `~/bin/slicc → ~/.slicc/bin/slicc` symlink replaces the
// real file instead of the link.
func executablePath() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		return resolved, nil
	}
	return exePath, nil
}

// startUpdateNotice begins the once-a-day cached release check for regular
// verbs. It prints the (cached) upgrade notice to stderr immediately and
// returns a flush func that briefly waits for the background cache refresh —
// call it after the verb finishes. Also sweeps the ".old" binary a Windows
// self-update leaves behind.
func startUpdateNotice() func() {
	if exePath, err := os.Executable(); err == nil {
		update.RemoveStaleBinary(exePath)
	}
	return update.NewNotifier(version, os.Stderr).Start()
}
