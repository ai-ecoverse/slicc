package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/cloud"
)

var cloudList = cloud.List

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

func resolveCloudSession(reveal bool, sel cloud.Selector, list func(bool) ([]cloud.Session, error)) (cloud.Session, error) {
	sessions, err := list(reveal)
	if err != nil {
		return cloud.Session{}, err
	}
	return cloud.Select(sessions, sel)
}

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
