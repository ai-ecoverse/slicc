package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/logging"
	"github.com/ai-ecoverse/slicc-cli/internal/ui"
)

func TestReadTextArg(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "prompt.txt")
	if err := os.WriteFile(file, []byte("from a file\n"), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}

	t.Run("joins multiple words verbatim", func(t *testing.T) {
		got, err := readTextArg([]string{"hello", "world"}, strings.NewReader(""))
		if err != nil || got != "hello world" {
			t.Fatalf("got %q, err %v; want \"hello world\"", got, err)
		}
	})
	t.Run("single non-@ word is literal", func(t *testing.T) {
		got, _ := readTextArg([]string{"hello"}, strings.NewReader(""))
		if got != "hello" {
			t.Fatalf("got %q, want hello", got)
		}
	})
	t.Run("@file reads the file, trimming a trailing newline", func(t *testing.T) {
		got, err := readTextArg([]string{"@" + file}, strings.NewReader(""))
		if err != nil || got != "from a file" {
			t.Fatalf("got %q, err %v; want \"from a file\"", got, err)
		}
	})
	t.Run("@- reads stdin", func(t *testing.T) {
		got, err := readTextArg([]string{"@-"}, strings.NewReader("piped in\n"))
		if err != nil || got != "piped in" {
			t.Fatalf("got %q, err %v; want \"piped in\"", got, err)
		}
	})
	t.Run("- reads stdin", func(t *testing.T) {
		got, err := readTextArg([]string{"-"}, strings.NewReader("dash stdin"))
		if err != nil || got != "dash stdin" {
			t.Fatalf("got %q, err %v; want \"dash stdin\"", got, err)
		}
	})
	t.Run("readPipedStdinBase64 reads piped bytes", func(t *testing.T) {
		got, err := readPipedStdinBase64(strings.NewReader("hello\n"))
		if err != nil {
			t.Fatal(err)
		}
		want := base64.StdEncoding.EncodeToString([]byte("hello\n"))
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})
	t.Run("readPipedStdinBase64 returns empty for empty pipe", func(t *testing.T) {
		got, err := readPipedStdinBase64(strings.NewReader(""))
		if err != nil || got != "" {
			t.Fatalf("got %q, err %v; want empty", got, err)
		}
	})
	t.Run("missing @file errors", func(t *testing.T) {
		if _, err := readTextArg([]string{"@" + filepath.Join(dir, "nope.txt")}, strings.NewReader("")); err == nil {
			t.Fatal("want an error for a missing @file")
		}
	})
}

func TestParseFollowArgs(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want followArgs
	}{
		{"bare runner", []string{"sh", "-c"}, followArgs{runner: []string{"sh", "-c"}, showBanner: true}},
		{"no-banner strips flag", []string{"--no-banner", "sh", "-c"}, followArgs{runner: []string{"sh", "-c"}}},
		{"help long", []string{"--help"}, followArgs{showBanner: true, help: true}},
		{"help short", []string{"-h"}, followArgs{showBanner: true, help: true}},
		{"terminator lets runner start with a flag", []string{"--", "--no-banner"}, followArgs{runner: []string{"--no-banner"}, showBanner: true}},
		{"empty", nil, followArgs{showBanner: true}},
		{"eval mode", []string{"--eval", "python", "-i"}, followArgs{runner: []string{"python", "-i"}, showBanner: true, eval: true}},
		{"eval quiet equals form", []string{"--eval", "--eval-quiet=750ms", "clojure"}, followArgs{runner: []string{"clojure"}, showBanner: true, eval: true, evalQuiet: 750 * time.Millisecond}},
		{"eval quiet value form", []string{"--eval", "--eval-quiet", "2s", "node", "-i"}, followArgs{runner: []string{"node", "-i"}, showBanner: true, eval: true, evalQuiet: 2 * time.Second}},
		{"invalid eval quiet falls back to default", []string{"--eval", "--eval-quiet=soon", "clojure"}, followArgs{runner: []string{"clojure"}, showBanner: true, eval: true}},
		{"eval composes with no-banner", []string{"--no-banner", "--eval", "python", "-i"}, followArgs{runner: []string{"python", "-i"}, eval: true}},
		{"plain strips flag", []string{"--plain", "sh", "-c"}, followArgs{runner: []string{"sh", "-c"}, showBanner: true, plain: true}},
		{"plain composes with the others", []string{"--no-banner", "--plain", "--eval", "python", "-i"}, followArgs{runner: []string{"python", "-i"}, plain: true, eval: true}},
		{"a runner named --plain survives the terminator", []string{"--", "--plain"}, followArgs{runner: []string{"--plain"}, showBanner: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseFollowArgs(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseFollowArgs(%v) = %+v; want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestRunnerExecWarning(t *testing.T) {
	warns := map[string]bool{
		"":                         false, // no runner
		"bash":                     true,  // the classic footgun — no -c
		"bash -c":                  false,
		"sh -c":                    false,
		"/bin/zsh":                 true, // path-qualified shell, still no -c
		"docker exec -i box sh -c": false,
		"docker exec -i box bash":  true,  // trailing shell without -c
		"docker run --rm img":      true,  // wrapper, no shell at all
		"python script.py":         false, // unknown runner — don't cry wolf
		"fish -c":                  false,
		"elvish":                   true,
	}
	for runnerStr, want := range warns {
		var runner []string
		if runnerStr != "" {
			runner = strings.Fields(runnerStr)
		}
		got := runnerExecWarning(runner) != ""
		if got != want {
			t.Errorf("runnerExecWarning(%q) warned=%v, want %v (msg=%q)", runnerStr, got, want, runnerExecWarning(runner))
		}
	}
}

func TestFollowMotd(t *testing.T) {
	if followMotd(nil, false) != "" {
		t.Fatal("no-runner follow should advertise no motd")
	}
	motd := followMotd([]string{"sh", "-c"}, false)
	for _, want := range []string{"exec target", "runner: sh -c", "@"} {
		if !strings.Contains(motd, want) {
			t.Errorf("motd %q missing %q", motd, want)
		}
	}
}

// bannerOutput renders a banner through a plain-mode console over a buffer, the
// presentation a redirected stderr gets.
func bannerOutput(fa followArgs) string {
	var buf bytes.Buffer
	printFollowBanner(ui.New(&buf, ui.Options{Tag: "slicc follow"}), fa)
	return buf.String()
}

func TestPrintFollowBanner(t *testing.T) {
	t.Run("art + exec warning + heuristic when runner is bare bash", func(t *testing.T) {
		out := bannerOutput(followArgs{runner: []string{"bash"}, showBanner: true})
		if !strings.Contains(out, "follow") { // the ASCII wordmark ends with "follow"
			t.Error("expected the ASCII wordmark when showArt=true")
		}
		if !strings.Contains(out, "the leader can run commands") {
			t.Error("expected the exec warning")
		}
		if !strings.Contains(out, "-c") {
			t.Error("expected the bare-bash heuristic warning suggesting -c")
		}
	})
	t.Run("no art when suppressed, but exec warning stays", func(t *testing.T) {
		out := bannerOutput(followArgs{runner: []string{"sh", "-c"}})
		if strings.Contains(out, "_____") {
			t.Error("art should be suppressed when showArt=false")
		}
		if !strings.Contains(out, "the leader can run commands") {
			t.Error("the exec warning must survive --no-banner")
		}
	})
	t.Run("no runner => exec-disabled notice", func(t *testing.T) {
		out := bannerOutput(followArgs{showBanner: true})
		if !strings.Contains(out, "slicc follow: connecting as ") {
			t.Errorf("expected the tagged plain-mode line, got %q", out)
		}
		if !strings.Contains(out, "exec disabled") {
			t.Error("expected the exec-disabled notice for a no-runner follow")
		}
	})
	t.Run("a redirected banner carries no escape sequences", func(t *testing.T) {
		out := bannerOutput(followArgs{runner: []string{"bash"}, showBanner: true, eval: false})
		if strings.Contains(out, "\x1b") {
			t.Errorf("plain-mode banner must be escape-free, got %q", out)
		}
	})
}

func TestTakePlainFlag(t *testing.T) {
	rest, plain := takePlainFlag([]string{"--plain", "scoop-1"})
	if !plain || !reflect.DeepEqual(rest, []string{"scoop-1"}) {
		t.Errorf("takePlainFlag consumed wrong: rest=%v plain=%v", rest, plain)
	}
	rest, plain = takePlainFlag([]string{"scoop-1"})
	if plain || !reflect.DeepEqual(rest, []string{"scoop-1"}) {
		t.Errorf("a scoop jid is not a flag: rest=%v plain=%v", rest, plain)
	}
	if rest, plain := takePlainFlag(nil); plain || rest != nil {
		t.Errorf("empty argv: rest=%v plain=%v", rest, plain)
	}
}

func TestOutputModeHonorsPlain(t *testing.T) {
	if mode := outputMode(os.Stderr, true); !mode.Plain() {
		t.Errorf("--plain must force plain output, got %+v", mode)
	}
}

func TestFollowPeer(t *testing.T) {
	unicode := ui.Mode{Unicode: true}
	if got := followPeer(unicode, nil); !strings.HasSuffix(got, "(no exec)") {
		t.Errorf("a no-runner follow should say so, got %q", got)
	}
	got := followPeer(unicode, []string{"bash", "-c"})
	if !strings.Contains(got, "@") || !strings.HasSuffix(got, "· bash -c") {
		t.Errorf("peer = %q, want user@host · bash -c", got)
	}
	if got := followPeer(ui.Mode{}, []string{"bash", "-c"}); !strings.HasSuffix(got, "| bash -c") {
		t.Errorf("ascii peer = %q, want the ASCII separator", got)
	}
}

func TestStatusTransitions(t *testing.T) {
	var st ui.Status
	markConnected(&st)
	markConnected(&st)
	if st.State != ui.StateConnected || st.Sessions != 2 || st.Attempt != 0 {
		t.Errorf("after two connects: %+v", st)
	}
	retrying(3, 8*time.Second)(&st)
	if st.State != ui.StateRetrying || st.Attempt != 3 {
		t.Errorf("after a retry: %+v", st)
	}
	if wait := time.Until(st.RetryAt); wait <= 0 || wait > 8*time.Second {
		t.Errorf("RetryAt is %s away, want just under 8s", wait)
	}
}

func TestLinkDiagCounterOnlyCountsWarnings(t *testing.T) {
	var buf bytes.Buffer
	console := ui.New(&buf, ui.Options{Tag: "slicc follow"})
	count := linkDiagCounter(console)
	count("turnc", slog.LevelDebug, "trace noise")
	count("turnc", slog.LevelInfo, "state change")
	count("turnc", slog.LevelWarn, "retrying")
	count("turnc", slog.LevelError, "Fail to refresh permissions")
	if got := console.Snapshot().Diags; got != 2 {
		t.Errorf("counted %d diagnostics, want the 2 at warn and above", got)
	}
	if buf.String() != "" {
		t.Errorf("link diagnostics must not print, got %q", buf.String())
	}
}

func TestPrintSessionSummary(t *testing.T) {
	t.Run("a session that never connected stays quiet", func(t *testing.T) {
		var buf bytes.Buffer
		printSessionSummary(ui.New(&buf, ui.Options{Tag: "slicc follow"}))
		if buf.String() != "" {
			t.Errorf("want no summary, got %q", buf.String())
		}
	})
	t.Run("a connected session reports its numbers", func(t *testing.T) {
		var buf bytes.Buffer
		console := ui.New(&buf, ui.Options{Tag: "slicc follow"})
		console.Update(func(s *ui.Status) {
			s.Sessions, s.Execs, s.Diags = 3, 1, 17
		})
		printSessionSummary(console)
		out := buf.String()
		for _, want := range []string{"session ended after", "1 exec,", "2 reconnects", "17 link diagnostics"} {
			if !strings.Contains(out, want) {
				t.Errorf("summary %q is missing %q", out, want)
			}
		}
	})
}

func TestPlural(t *testing.T) {
	cases := map[int]string{0: "0 execs", 1: "1 exec", 2: "2 execs"}
	for n, want := range cases {
		if got := plural(n, "exec"); got != want {
			t.Errorf("plural(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestShortHost(t *testing.T) {
	cases := map[string]string{
		"laptop.local": "laptop",
		"laptop":       "laptop",
		"a.b.c":        "a",
		".leading":     ".leading",
		"":             "",
	}
	for in, want := range cases {
		if got := shortHost(in); got != want {
			t.Errorf("shortHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWatchModesDropTheBarWhenStdoutIsATerminal(t *testing.T) {
	tty := ui.Mode{Color: true, Sticky: true, Unicode: true}
	piped := ui.Mode{}

	// Both on the terminal: the transcript writes partial lines to stdout, so
	// the bar has to go — but the status lines keep their colors.
	console, out := watchModes(tty, tty)
	if console.Sticky {
		t.Error("kept the status bar while the transcript shares the screen")
	}
	if !console.Color || !out.Sticky {
		t.Errorf("lost more than the bar: console=%+v out=%+v", console, out)
	}

	// Transcript redirected: stderr alone owns the screen, bar included.
	if console, _ = watchModes(tty, piped); !console.Sticky {
		t.Error("dropped the status bar even though stdout is redirected")
	}
}

func TestStickyUnlessLogging(t *testing.T) {
	tty := ui.Mode{Color: true, Sticky: true, Unicode: true}

	// Diagnostics off (the default): the bar owns the last row.
	off := logging.New(io.Discard, logging.Config{})
	if got := stickyUnlessLogging(tty, off); !got.Sticky {
		t.Error("dropped the status bar while nothing else writes to stderr")
	}

	// SLICC_DEBUG=1: tray's records go straight to stderr, so the bar has to
	// step aside — but the status lines keep their colors.
	on := logging.New(io.Discard, logging.Config{Enabled: true, Level: slog.LevelDebug})
	got := stickyUnlessLogging(tty, on)
	if got.Sticky {
		t.Error("kept the status bar while diagnostics write to the same stream")
	}
	if !got.Color || !got.Unicode {
		t.Errorf("lost more than the bar: %+v", got)
	}

	// A nil logger is a valid no-op logger; it must not be mistaken for one that
	// is emitting.
	if got := stickyUnlessLogging(tty, nil); !got.Sticky {
		t.Error("a nil logger dropped the status bar")
	}
}
