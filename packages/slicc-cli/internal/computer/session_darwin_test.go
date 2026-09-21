//go:build darwin

package computer

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLauncher writes a shell script that stands in for the Sliccstart bundle
// and points SLICCSTART_APP at it, which is the override LocateExecutable
// already honours for `--list-sessions`. It records its argv so a test can
// assert what the CLI actually asked the launcher to do.
func fakeLauncher(t *testing.T, body string) (argvPath string) {
	t.Helper()
	dir := t.TempDir()
	argvPath = filepath.Join(dir, "argv")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + argvPath + "\n" + body
	exe := filepath.Join(dir, "Sliccstart")
	if err := os.WriteFile(exe, []byte(script), 0o755); err != nil {
		t.Fatalf("writing fake launcher: %v", err)
	}
	t.Setenv("SLICCSTART_APP", exe)
	return argvPath
}

func readArgv(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading recorded argv: %v", err)
	}
	return strings.Fields(string(data))
}

func TestStartPassesTheJoinUrlAndPairTokenToTheLauncher(t *testing.T) {
	argvPath := fakeLauncher(t, "echo "+readyLine+"\nwhile :; do sleep 1; done\n")

	session, err := Start(context.Background(), Options{
		JoinURL: "https://tray.test/join/abc",
		PairID:  "pair-123",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer session.Stop()

	argv := readArgv(t, argvPath)
	want := []string{followFlag, "https://tray.test/join/abc", pairFlag, "pair-123"}
	if strings.Join(argv, " ") != strings.Join(want, " ") {
		t.Errorf("launcher argv = %v, want %v", argv, want)
	}
}

func TestStartWithoutAPairTokenOmitsTheFlag(t *testing.T) {
	argvPath := fakeLauncher(t, "echo "+readyLine+"\nwhile :; do sleep 1; done\n")

	session, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer session.Stop()

	// An empty --pair value would reach the leader as a real token and group
	// this Mac with every other peer that sent one.
	for _, arg := range readArgv(t, argvPath) {
		if arg == pairFlag {
			t.Fatalf("argv should not carry %s when no token was minted", pairFlag)
		}
	}
}

func TestStartRejectsALauncherThatNeverReportsReady(t *testing.T) {
	// The real symptom of an outdated Sliccstart: it ignores the unknown flag,
	// boots its GUI, and sits there forever looking like a healthy child.
	fakeLauncher(t, "while :; do sleep 1; done\n")
	startTimeout = 300 * time.Millisecond
	t.Cleanup(func() { startTimeout = 30 * time.Second })

	_, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if !errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("Start error = %v, want ErrOutdatedLauncher", err)
	}
}

func TestStartRejectsALauncherThatExitsWithoutReporting(t *testing.T) {
	fakeLauncher(t, "echo 'unknown option' >&2\nexit 64\n")

	_, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if !errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("Start error = %v, want ErrOutdatedLauncher", err)
	}
	// The launcher's own complaint is worth more than our guess at the cause.
	if !strings.Contains(err.Error(), "unknown option") {
		t.Errorf("error %q should quote the launcher's stderr", err)
	}
}

func TestStartRequiresAJoinUrl(t *testing.T) {
	if _, err := Start(context.Background(), Options{}); err == nil {
		t.Fatal("Start with no join URL should fail")
	}
}

func TestRetargetRestartsTheLauncherOnTheReplacementTray(t *testing.T) {
	argvPath := fakeLauncher(t, "echo "+readyLine+"\nwhile :; do sleep 1; done\n")

	session, err := Start(context.Background(), Options{
		JoinURL: "https://tray.test/join/old",
		PairID:  "pair-123",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer session.Stop()

	if err := session.Retarget(context.Background(), "https://tray.test/join/new"); err != nil {
		t.Fatalf("Retarget: %v", err)
	}
	argv := readArgv(t, argvPath)
	if len(argv) != 8 || argv[5] != "https://tray.test/join/new" {
		t.Fatalf("launcher should have been restarted on the new tray, argv = %v", argv)
	}

	// Retargeting to the tray it is already on must not churn the connection —
	// a TRAY_SUPERSEDED chain can report the same URL more than once.
	if err := session.Retarget(context.Background(), "https://tray.test/join/new"); err != nil {
		t.Fatalf("idempotent Retarget: %v", err)
	}
	if got := len(readArgv(t, argvPath)); got != 8 {
		t.Errorf("re-targeting to the same URL respawned the launcher (argv words = %d)", got)
	}
}

func TestStopIsIdempotentAndSafeAfterRetarget(t *testing.T) {
	fakeLauncher(t, "echo "+readyLine+"\nwhile :; do sleep 1; done\n")

	session, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.Stop()
	session.Stop()

	// A tray move arriving after the CLI began shutting down must not resurrect
	// a launcher nobody will ever reap.
	if err := session.Retarget(context.Background(), "https://tray.test/join/new"); err != nil {
		t.Fatalf("Retarget after Stop: %v", err)
	}
}

func TestPreflightReadsTheGrantStateEvenOnANonZeroExit(t *testing.T) {
	// Exit 3 is "asked, not fully granted" — the state is still the answer.
	argvPath := fakeLauncher(t, `echo '{"accessibility":false,"screenRecording":true}'`+"\nexit 3\n")

	grants, err := Preflight(context.Background())
	if err != nil {
		t.Fatalf("Preflight: %v", err)
	}
	if !grants.ScreenRecording || grants.Accessibility {
		t.Errorf("grants = %+v, want screen recording only", grants)
	}
	argv := readArgv(t, argvPath)
	if strings.Join(argv, " ") != preflightFlag+" "+jsonFlag {
		t.Errorf("preflight argv = %v", argv)
	}
}

func TestPreflightReportsAnOutdatedLauncherThatPrintsNoJson(t *testing.T) {
	fakeLauncher(t, "exit 0\n")

	if _, err := Preflight(context.Background()); !errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("Preflight error = %v, want ErrOutdatedLauncher", err)
	}
}

func TestReadyWatcherDetectsTheLineAcrossWriteBoundaries(t *testing.T) {
	w := newReadyWatcher(func(string, ...any) {})
	// The launcher's stdout is a pipe: nothing guarantees one write per line.
	mustWrite(t, w, "booting\nSLICC_COMPUTER")
	select {
	case <-w.ready:
		t.Fatal("a partial line must not count as ready")
	default:
	}
	mustWrite(t, w, "_FOLLOW_READY\nattached\n")
	select {
	case <-w.ready:
	default:
		t.Fatal("the reassembled line should have signalled ready")
	}
	// Still consuming afterwards, so a chatty launcher cannot fill the pipe.
	mustWrite(t, w, "more output\n")
}

func TestReadyWatcherAwaitPrefersALateReadyOverTheExitSignal(t *testing.T) {
	w := newReadyWatcher(func(string, ...any) {})
	exited := make(chan struct{})
	mustWrite(t, w, readyLine+"\n")
	close(exited)
	// Wait has returned, so the stdout copy is complete: a ready line in the
	// final write is a successful start, not a dead launcher.
	if err := w.await(exited); err != nil {
		t.Fatalf("await = %v, want nil", err)
	}
}

func TestReadyWatcherAwaitReportsALauncherThatDiedSilently(t *testing.T) {
	w := newReadyWatcher(func(string, ...any) {})
	exited := make(chan struct{})
	close(exited)
	if err := w.await(exited); !errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("await = %v, want ErrOutdatedLauncher", err)
	}
}

func TestReadyWatcherLogsEveryLineOnce(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	w := newReadyWatcher(func(_ string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, args[0].(string))
	})
	mustWrite(t, w, "one\n\n  two  \nthree\n")
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(lines, ",") != "one,two,three" {
		t.Errorf("logged %v, want trimmed non-empty lines", lines)
	}
}

func mustWrite(t *testing.T, w *readyWatcher, s string) {
	t.Helper()
	n, err := w.Write([]byte(s))
	if err != nil || n != len(s) {
		t.Fatalf("Write(%q) = (%d, %v)", s, n, err)
	}
}
