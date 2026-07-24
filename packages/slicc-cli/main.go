// Command slicc is a headless SLICC follower CLI. It joins a leader session over
// WebRTC and offers three verbs:
//
//	slicc <join-url> prompt "text"   stream one assistant turn, then exit
//	slicc <join-url> exec "command"  run a command in the leader's shell, stream output
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
		return cmdPrompt(ctx, joinURL, strings.Join(rest, " "))
	case "exec":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc exec: missing command")
			return 2
		}
		return cmdExec(ctx, joinURL, strings.Join(rest, " "))
	case "follow":
		// Everything after `follow` is the runner argv (verbatim) the leader's
		// commands are handed to — no slicc-level flag parsing, so runner flags
		// like `-i` / `-c` pass straight through. A leading -h/--help is help.
		if len(rest) > 0 && (rest[0] == "-h" || rest[0] == "--help") {
			usage(os.Stdout)
			return 0
		}
		return cmdFollow(ctx, joinURL, rest)
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
  slicc <join-url> follow [runner...]
                                      Stay connected as a follower. If a runner is given,
                                      the leader can run commands on THIS machine — each
                                      one is executed as "<runner> <command>", as the user
                                      who started slicc. With no runner, exec is refused.
                                        follow bash -c
                                        follow sh -c
                                        follow docker exec -i sandbox sh -c
  slicc --version
  slicc --help

The <join-url> is a leader's https://…/join/<token> link.
`)
}
