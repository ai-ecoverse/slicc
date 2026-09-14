package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ai-ecoverse/slicc-cli/internal/update"
)





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






func startUpdateNotice() func() {
	if exePath, err := os.Executable(); err == nil {
		update.RemoveStaleBinary(exePath)
	}
	return update.NewNotifier(version, os.Stderr).Start()
}
