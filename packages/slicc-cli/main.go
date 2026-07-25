// Command slicc is a headless SLICC follower CLI. It joins a leader session over
// WebRTC and offers four verbs:
//
//	slicc <join-url> prompt "text"   stream one assistant turn, then exit
//	slicc <join-url> exec "command"  run a command in the leader's shell, stream output
//	slicc <join-url> watch [scoop]   tail the leader's agent output (default the cone), until Ctrl+C
//	slicc <join-url> follow          stay connected; run leader-issued commands locally
//
// In `follow` the trailing argv is the runner the leader's commands are handed to
// (e.g. `follow bash -c`, `follow docker exec -i box sh -c`) — the command runs
// as the user who started the process, scoped to whatever the runner allows. With
// no runner, `follow` connects as a plain follower and refuses every command.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// version is stamped at build time via -ldflags "-X main.version=…".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "-h", "--help", "help":
		usage(os.Stdout)
		return 0
	case "-v", "--version", "version":
		fmt.Println("slicc", version)
		return 0
	}

	joinURL := args[0]
	if !strings.HasPrefix(joinURL, "http://") && !strings.HasPrefix(joinURL, "https://") {
		fmt.Fprintf(os.Stderr, "slicc: first argument must be a join URL (https://…/join/<token>), got %q\n", joinURL)
		return 2
	}
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "slicc: missing subcommand (prompt | exec | follow)")
		usage(os.Stderr)
		return 2
	}
	sub := args[1]
	rest := args[2:]

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch sub {
	case "prompt":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc prompt: missing prompt text")
			return 2
		}
		text, err := readTextArg(rest, os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc prompt: %s\n", err)
			return 1
		}
		return cmdPrompt(ctx, joinURL, text)
	case "exec":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc exec: missing command")
			return 2
		}
		command, err := readTextArg(rest, os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc exec: %s\n", err)
			return 1
		}
		return cmdExec(ctx, joinURL, command)
	case "watch":
		// Optional positional: the scoop jid to tail (default the cone).
		scoopJid := "cone"
		if len(rest) > 0 {
			if rest[0] == "-h" || rest[0] == "--help" {
				usage(os.Stdout)
				return 0
			}
			scoopJid = rest[0]
		}
		return cmdWatch(ctx, joinURL, scoopJid)
	case "follow":
		// A leading `--no-banner` (or `--`) is consumed by slicc; everything
		// after is the runner argv (verbatim), so runner flags like `-i` / `-c`
		// pass straight through.
		runner, showBanner, help := parseFollowArgs(rest)
		if help {
			usage(os.Stdout)
			return 0
		}
		return cmdFollow(ctx, joinURL, runner, showBanner)
	default:
		fmt.Fprintf(os.Stderr, "slicc: unknown subcommand %q\n", sub)
		usage(os.Stderr)
		return 2
	}
}

func usage(w *os.File) {
	fmt.Fprint(w, `slicc — headless SLICC follower CLI

Usage:
  slicc <join-url> prompt "<text>"    Stream one assistant turn from the leader, then exit
  slicc <join-url> exec "<command>"   Run a command in the leader's shell, stream stdout/stderr
  slicc <join-url> watch [scoop]      Tail the leader's agent output (default the cone) until Ctrl+C
  slicc <join-url> follow [--no-banner] [runner...]
                                      Stay connected as a follower. If a runner is given,
                                      the leader can run commands on THIS machine — each
                                      one is executed as "<runner> <command>", as the user
                                      who started slicc. With no runner, exec is refused.
                                        follow bash -c
                                        follow sh -c
                                        follow docker exec -i sandbox sh -c
  slicc --version
  slicc --help

The <text>/<command> argument, curl-style:
  "some text"    a literal string (multiple words are joined with spaces)
  @path          read it from the file at <path>
  @-  or  -      read it from stdin        (echo "hi" | slicc <url> prompt -)

The <join-url> is a leader's https://…/join/<token> link.
`)
}

// readTextArg resolves the text/command argument for prompt/exec, curl-style:
//
//	"-" or "@-"   → read all of stdin
//	"@<path>"     → read the file at <path>
//	otherwise     → the args joined with spaces (verbatim; preserves the old behavior)
//
// The @ / - forms only apply when there is exactly one argument, so
// `prompt hello world` still sends "hello world" and only a lone `@file`
// (typically quoted) is treated as a file.
func readTextArg(args []string, stdin io.Reader) (string, error) {
	if len(args) == 1 {
		switch a := args[0]; {
		case a == "-" || a == "@-":
			b, err := io.ReadAll(stdin)
			if err != nil {
				return "", fmt.Errorf("reading stdin: %w", err)
			}
			return strings.TrimRight(string(b), "\n"), nil
		case strings.HasPrefix(a, "@"):
			b, err := os.ReadFile(a[1:])
			if err != nil {
				return "", err
			}
			return strings.TrimRight(string(b), "\n"), nil
		}
	}
	return strings.Join(args, " "), nil
}

// parseFollowArgs consumes slicc's own leading `follow` options (`--no-banner`,
// `--help`, and the `--` end-of-options terminator) and returns the remaining
// argv as the runner (verbatim). `--` lets a runner whose first token would
// otherwise look like a slicc flag pass through untouched.
func parseFollowArgs(rest []string) (runner []string, showBanner bool, help bool) {
	showBanner = true
	for len(rest) > 0 {
		switch rest[0] {
		case "-h", "--help":
			return nil, showBanner, true
		case "--no-banner":
			showBanner = false
			rest = rest[1:]
			continue
		case "--":
			return rest[1:], showBanner, false
		}
		break
	}
	return rest, showBanner, false
}
