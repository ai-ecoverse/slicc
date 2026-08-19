// Command slicc is a headless SLICC follower CLI. It joins a leader session over
// WebRTC and offers four verbs:
//
//	slicc <join-url> prompt "text"   stream one assistant turn, then exit
//	slicc <join-url> exec "command"  run a command in the leader's shell, stream output
//	slicc <join-url> watch [scoop]   tail the leader's live agent output (a scoop jid filters), until Ctrl+C
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
	"time"
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
	case "update":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		defer initTelemetry("update")()
		return cmdUpdate(ctx, args[1:])
	case "list-sessions":
		return cmdListSessions(args[1:])
	case "follow-cloud", "prompt-cloud", "exec-cloud", "watch-cloud":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		defer initTelemetry(args[0])()
		defer startUpdateNotice()()
		return cmdCloud(ctx, args[0], args[1:])
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

	// Launch telemetry (Enter checkpoint only; see telemetry.go) — one
	// sampling decision per process, opt-out via SLICC_NO_TELEMETRY=1,
	// silent by construction on non-release builds.
	defer initTelemetry(sub)()

	// Once-a-day cached upgrade notice (stderr), refreshed in the background;
	// the deferred flush lets a short-lived verb persist the refresh result.
	defer startUpdateNotice()()

	return dispatchJoinVerb(ctx, joinURL, sub, rest)
}

// dispatchJoinVerb runs a subcommand against an explicit join URL.
func dispatchJoinVerb(ctx context.Context, joinURL, sub string, rest []string) int {
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
		// Optional positional: a scoop jid to filter to. Default empty = tail
		// whatever the leader broadcasts (the selected scoop — the browser view),
		// since the cone's jid is a generated uid, not the literal "cone".
		rest, plain := takePlainFlag(rest)
		scoopJid := ""
		if len(rest) > 0 {
			if rest[0] == "-h" || rest[0] == "--help" {
				usage(os.Stdout)
				return 0
			}
			scoopJid = rest[0]
		}
		return cmdWatch(ctx, joinURL, scoopJid, plain)
	case "follow":
		// Leading slicc-owned options (`--no-banner`, `--eval`, `--eval-quiet`,
		// `--`) are consumed; everything after is the runner argv (verbatim), so
		// runner flags like `-i` / `-c` pass straight through.
		fa := parseFollowArgs(rest)
		if fa.help {
			usage(os.Stdout)
			return 0
		}
		return cmdFollow(ctx, joinURL, fa)
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
  slicc <join-url> watch [--plain] [scoop]
                                      Tail the leader's live agent output (a scoop jid filters) until Ctrl+C
  slicc <join-url> follow [--no-banner] [--plain] [runner...]
                                      Stay connected as a follower. If a runner is given,
                                      the leader can run commands on THIS machine — each
                                      one is executed as "<runner> <command>", as the user
                                      who started slicc. With no runner, exec is refused.
                                        follow bash -c
                                        follow sh -c
                                        follow docker exec -i sandbox sh -c
  slicc <join-url> follow --eval [--eval-quiet <dur>] <repl...>
                                      REPL mode: spawn <repl> ONCE and write each leader
                                      command as a line to its stdin; the reply is the
                                      output that follows, ended by <dur> (default 500ms)
                                      of quiet. State persists across commands.
                                        follow --eval python -i
                                        follow --eval node -i
                                        follow --eval clojure
  slicc update [--check]              Self-update to the newest released CLI binary
                                      (--check only reports; SLICC_NO_UPDATE_CHECK=1
                                      disables the once-a-day launch check)

iCloud tray sessions (macOS only — read from the signed Sliccstart launcher):
  slicc list-sessions [--json]        List active tray sessions synced from your
                                      other devices (metadata only; no join URLs)
  slicc <verb>-cloud [--index N | --session <id-prefix>] [args...]
                                      Resolve a session's join URL from iCloud
                                      (newest by default) and run <verb>, where
                                      <verb> is follow | prompt | exec | watch.
                                      Revealing the URL prompts for approval on
                                      the Mac; over SSH it is denied until you
                                      grant it once from the screen.
                                        slicc follow-cloud bash -c
                                        slicc prompt-cloud "summarize the diff"
                                        slicc exec-cloud "git status"
                                        slicc watch-cloud
                                        slicc follow-cloud --index 1 sh -c

  slicc --version
  slicc --help

The <text>/<command> argument, curl-style:
  "some text"    a literal string (multiple words are joined with spaces)
  @path          read it from the file at <path>
  @-  or  -      read it from stdin        (echo "hi" | slicc <url> prompt -)

The <join-url> is a leader's https://…/join/<token> link.

On an interactive terminal, follow/watch keep a live status bar (connection
state, uptime, heartbeat, exec + reconnect counts) below their output. Piped
output is plain by construction; --plain or SLICC_NO_TUI=1 forces it, and
NO_COLOR keeps the bar without color.
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

// followArgs is the parsed `follow` invocation: slicc-owned options plus the
// runner argv.
type followArgs struct {
	runner     []string
	showBanner bool
	help       bool
	// plain forces the piped output style (no status bar, no color) even on an
	// interactive terminal.
	plain bool
	// eval switches follow into persistent-REPL mode: the runner is spawned
	// once and each leader command is written as a line to its stdin.
	eval bool
	// evalQuiet overrides the output-quiescence window ending each eval
	// response (0 = execrun.DefaultEvalQuiet).
	evalQuiet time.Duration
}

// parseFollowArgs consumes slicc's own leading `follow` options (`--no-banner`,
// `--eval`, `--eval-quiet <dur>`, `--help`, and the `--` end-of-options
// terminator) and returns the remaining argv as the runner (verbatim). `--`
// lets a runner whose first token would otherwise look like a slicc flag pass
// through untouched.
func parseFollowArgs(rest []string) followArgs {
	fa := followArgs{showBanner: true}
	for len(rest) > 0 {
		switch {
		case rest[0] == "-h" || rest[0] == "--help":
			fa.help = true
			return fa
		case rest[0] == "--no-banner":
			fa.showBanner = false
			rest = rest[1:]
			continue
		case rest[0] == "--plain":
			fa.plain = true
			rest = rest[1:]
			continue
		case rest[0] == "--eval":
			fa.eval = true
			rest = rest[1:]
			continue
		case strings.HasPrefix(rest[0], "--eval-quiet="):
			fa.evalQuiet = parseEvalQuiet(rest[0][len("--eval-quiet="):])
			rest = rest[1:]
			continue
		case rest[0] == "--eval-quiet" && len(rest) > 1:
			fa.evalQuiet = parseEvalQuiet(rest[1])
			rest = rest[2:]
			continue
		case rest[0] == "--":
			fa.runner = rest[1:]
			return fa
		}
		break
	}
	fa.runner = rest
	return fa
}

// takePlainFlag consumes a leading `--plain` from a verb's argv, returning the
// rest. Only `watch` needs it standalone; `follow` parses it with its other
// options.
func takePlainFlag(rest []string) ([]string, bool) {
	if len(rest) > 0 && rest[0] == "--plain" {
		return rest[1:], true
	}
	return rest, false
}

// parseEvalQuiet parses a `--eval-quiet` duration ("750ms", "2s"); invalid or
// non-positive values fall back to the default (0), matching how other flags
// ignore unusable values.
func parseEvalQuiet(value string) time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil || d <= 0 {
		return 0
	}
	return d
}
