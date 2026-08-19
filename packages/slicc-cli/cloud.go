package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/cloud"
)

// cloudList is the seam through which the cloud verbs read iCloud tray sessions.
// It defaults to the real (platform-specific) reader and is overridden in tests.
var cloudList = cloud.List

// cmdListSessions prints the active iCloud tray sessions (metadata only — join
// URLs are never shown here, so the output is safe to pipe and log).
func cmdListSessions(args []string) int {
	jsonOut := false
	for _, a := range args {
		switch a {
		case "--json":
			jsonOut = true
		case "-h", "--help":
			usage(os.Stdout)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "slicc list-sessions: unknown option %q\n", a)
			return 2
		}
	}

	sessions, err := cloudList(false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc list-sessions: %s\n", err)
		return 1
	}

	if jsonOut {
		encoded, err := json.MarshalIndent(sessions, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc list-sessions: %s\n", err)
			return 1
		}
		fmt.Println(string(encoded))
		return 0
	}

	fmt.Print(cloud.FormatTable(sessions, time.Now()))
	return 0
}

// resolveCloudSession lists sessions (revealing join URLs when reveal is set)
// and applies the selector. Injecting the lister keeps it testable off macOS.
func resolveCloudSession(reveal bool, sel cloud.Selector, list func(bool) ([]cloud.Session, error)) (cloud.Session, error) {
	sessions, err := list(reveal)
	if err != nil {
		return cloud.Session{}, err
	}
	return cloud.Select(sessions, sel)
}

// cmdCloud implements the `<verb>-cloud` family: resolve a session's join URL
// from iCloud (which prompts for reveal consent on the Mac), then hand off to
// the matching plain verb. The join URL is never printed.
func cmdCloud(ctx context.Context, verb string, args []string) int {
	sel, rest, err := cloud.ParseSelector(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc %s: %s\n", verb, err)
		return 2
	}

	session, err := resolveCloudSession(true, sel, cloudList)
	if err != nil {
		fmt.Fprintf(os.Stderr, "slicc %s: %s\n", verb, err)
		return 1
	}
	if session.JoinURL == "" {
		fmt.Fprintf(os.Stderr, "slicc %s: resolved session has no join URL (reveal denied?)\n", verb)
		return 1
	}

	switch verb {
	case "follow-cloud":
		fa := parseFollowArgs(rest)
		if fa.help {
			usage(os.Stdout)
			return 0
		}
		return cmdFollow(ctx, session.JoinURL, fa)
	case "prompt-cloud":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc prompt-cloud: missing prompt text")
			return 2
		}
		text, err := readTextArg(rest, os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc prompt-cloud: %s\n", err)
			return 1
		}
		return cmdPrompt(ctx, session.JoinURL, text)
	case "exec-cloud":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc exec-cloud: missing command")
			return 2
		}
		command, err := readTextArg(rest, os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc exec-cloud: %s\n", err)
			return 1
		}
		return cmdExec(ctx, session.JoinURL, command)
	case "watch-cloud":
		rest, plain := takePlainFlag(rest)
		scoopJid := ""
		if len(rest) > 0 {
			scoopJid = rest[0]
		}
		return cmdWatch(ctx, session.JoinURL, scoopJid, plain)
	default:
		fmt.Fprintf(os.Stderr, "slicc: unknown cloud verb %q\n", verb)
		return 2
	}
}
