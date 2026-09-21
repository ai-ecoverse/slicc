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

// A launcher that understands the flag, attaches, and then stays up — the
// happy path every lifecycle test starts from.
const healthyLauncher = "echo " + readyLine + "\necho " + attachedLine + "\nwhile :; do sleep 1; done\n"

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

// shortStartTimeout / shortAttachTimeout keep the hang-case tests fast. Only
// the phase under test is shortened: spawning a shell under -race can take
// longer than a hang-test budget, and a too-short *start* timeout would turn an
// attach test into a false "outdated launcher".
func shortStartTimeout(t *testing.T) {
	t.Helper()
	prev := startTimeout
	startTimeout = 500 * time.Millisecond
	t.Cleanup(func() { startTimeout = prev })
}

func shortAttachTimeout(t *testing.T) {
	t.Helper()
	prev := attachTimeout
	attachTimeout = 500 * time.Millisecond
	t.Cleanup(func() { attachTimeout = prev })
}

func TestStartPassesTheJoinUrlAndPairTokenToTheLauncher(t *testing.T) {
	argvPath := fakeLauncher(t, healthyLauncher)

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
	argvPath := fakeLauncher(t, healthyLauncher)

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
	shortStartTimeout(t)

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

// The first version treated "understood the flag" as success, so a launcher
// that could not reach the leader still let `--computer=require` continue
// without a screen (#3339 review). Ready is necessary, not sufficient.
func TestStartFailsWhenTheLauncherUnderstandsButCannotAttach(t *testing.T) {
	fakeLauncher(t, "echo "+readyLine+"\necho '"+failedPrefix+" signaling returned 404'\nexit 1\n")

	_, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if !errors.Is(err, ErrAttachFailed) {
		t.Fatalf("Start error = %v, want ErrAttachFailed", err)
	}
	// An unreachable leader is NOT an outdated launcher — telling the user to
	// update a current Sliccstart would send them the wrong way.
	if errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("attach failure misreported as an outdated launcher: %v", err)
	}
	if !strings.Contains(err.Error(), "signaling returned 404") {
		t.Errorf("error %q should carry the launcher's reason", err)
	}
}

func TestStartFailsWhenTheLauncherExitsAfterReadyWithoutAReason(t *testing.T) {
	fakeLauncher(t, "echo "+readyLine+"\nexit 1\n")

	_, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if !errors.Is(err, ErrAttachFailed) {
		t.Fatalf("Start error = %v, want ErrAttachFailed", err)
	}
}

func TestStartGivesUpOnALauncherThatNeverAttaches(t *testing.T) {
	fakeLauncher(t, "echo "+readyLine+"\nwhile :; do sleep 1; done\n")
	shortAttachTimeout(t)

	_, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if !errors.Is(err, ErrAttachFailed) {
		t.Fatalf("Start error = %v, want ErrAttachFailed", err)
	}
}

func TestStartRequiresAJoinUrl(t *testing.T) {
	if _, err := Start(context.Background(), Options{}); err == nil {
		t.Fatal("Start with no join URL should fail")
	}
}

// A launcher that gives up reconnecting after a leader drop, or crashes, must
// not vanish from the session in silence.
func TestAnUnexpectedExitAfterAttachingIsReported(t *testing.T) {
	fakeLauncher(t, "echo "+readyLine+"\necho "+attachedLine+"\nsleep 0.2\necho '"+failedPrefix+" ICE failed'\nexit 1\n")

	reasons := make(chan string, 1)
	session, err := Start(context.Background(), Options{
		JoinURL: "https://tray.test/join/abc",
		OnExit:  func(reason string) { reasons <- reason },
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer session.Stop()

	select {
	case reason := <-reasons:
		if reason != "ICE failed" {
			t.Errorf("OnExit reason = %q, want the launcher's own", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnExit was never called for a launcher that went away")
	}
}

func TestStopAndRetargetAreNotReportedAsExits(t *testing.T) {
	fakeLauncher(t, healthyLauncher)

	var mu sync.Mutex
	var reasons []string
	session, err := Start(context.Background(), Options{
		JoinURL: "https://tray.test/join/old",
		OnExit: func(reason string) {
			mu.Lock()
			reasons = append(reasons, reason)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := session.Retarget(context.Background(), "https://tray.test/join/new"); err != nil {
		t.Fatalf("Retarget: %v", err)
	}
	session.Stop()
	time.Sleep(200 * time.Millisecond) // let any stray watcher run

	mu.Lock()
	defer mu.Unlock()
	if len(reasons) != 0 {
		t.Errorf("OnExit fired for exits this side asked for: %v", reasons)
	}
}

func TestRetargetRestartsTheLauncherOnTheReplacementTray(t *testing.T) {
	argvPath := fakeLauncher(t, healthyLauncher)

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
	fakeLauncher(t, healthyLauncher)

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

func TestWatcherDetectsLinesAcrossWriteBoundaries(t *testing.T) {
	w := newLauncherWatcher(func(string, ...any) {})
	// The launcher's stdout is a pipe: nothing guarantees one write per line.
	mustWrite(t, w, "booting\nSLICC_COMPUTER")
	select {
	case <-w.ready:
		t.Fatal("a partial line must not count as ready")
	default:
	}
	mustWrite(t, w, "_FOLLOW_READY\nSLICC_COMPUTER_FOLLOW_ATT")
	select {
	case <-w.ready:
	default:
		t.Fatal("the reassembled line should have signalled ready")
	}
	mustWrite(t, w, "ACHED\n")
	select {
	case <-w.attached:
	default:
		t.Fatal("the reassembled attached line should have signalled")
	}
	// Still consuming afterwards, so a chatty launcher cannot fill the pipe.
	mustWrite(t, w, "more output\n")
}

func TestWatcherAwaitReadyPrefersALateReadyOverTheExitSignal(t *testing.T) {
	w := newLauncherWatcher(func(string, ...any) {})
	exited := make(chan struct{})
	mustWrite(t, w, readyLine+"\n")
	close(exited)
	// Wait has returned, so the stdout copy is complete: a ready line in the
	// final write is a launcher that understood, not one that did not.
	if err := w.awaitReady(exited); err != nil {
		t.Fatalf("awaitReady = %v, want nil", err)
	}
}

func TestWatcherAwaitReadyReportsALauncherThatDiedSilently(t *testing.T) {
	w := newLauncherWatcher(func(string, ...any) {})
	exited := make(chan struct{})
	close(exited)
	if err := w.awaitReady(exited); !errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("awaitReady = %v, want ErrOutdatedLauncher", err)
	}
}

// Only the exact prefix, followed by a space or nothing, is a failure line — a
// log line that merely starts with the same letters must not end the session.
func TestWatcherOnlyTreatsTheExactFailurePrefixAsFailure(t *testing.T) {
	w := newLauncherWatcher(func(string, ...any) {})
	mustWrite(t, w, failedPrefix+"_NOT_REALLY\n")
	select {
	case <-w.failed:
		t.Fatal("a lookalike line was taken as a failure")
	default:
	}
	mustWrite(t, w, failedPrefix+"\n")
	select {
	case <-w.failed:
	default:
		t.Fatal("the bare prefix is a failure with no reason")
	}
	if got := w.failureOr("fallback"); got != "fallback" {
		t.Errorf("failureOr = %q, want the fallback for a reasonless failure", got)
	}
}

func TestWatcherLogsEveryLineOnce(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	w := newLauncherWatcher(func(_ string, args ...any) {
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

func mustWrite(t *testing.T, w *launcherWatcher, s string) {
	t.Helper()
	n, err := w.Write([]byte(s))
	if err != nil || n != len(s) {
		t.Fatalf("Write(%q) = (%d, %v)", s, n, err)
	}
}
