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



const healthyLauncher = "echo " + readyLine + "\necho " + attachedLine + "\nwhile :; do sleep 1; done\n"





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

	
	
	for _, arg := range readArgv(t, argvPath) {
		if arg == pairFlag {
			t.Fatalf("argv should not carry %s when no token was minted", pairFlag)
		}
	}
}

func TestStartRejectsALauncherThatNeverReportsReady(t *testing.T) {
	
	
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
	
	if !strings.Contains(err.Error(), "unknown option") {
		t.Errorf("error %q should quote the launcher's stderr", err)
	}
}




func TestStartFailsWhenTheLauncherUnderstandsButCannotAttach(t *testing.T) {
	fakeLauncher(t, "echo "+readyLine+"\necho '"+failedPrefix+" signaling returned 404'\nexit 1\n")

	_, err := Start(context.Background(), Options{JoinURL: "https://tray.test/join/abc"})
	if !errors.Is(err, ErrAttachFailed) {
		t.Fatalf("Start error = %v, want ErrAttachFailed", err)
	}
	
	
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
	time.Sleep(200 * time.Millisecond) 

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

	
	
	if err := session.Retarget(context.Background(), "https://tray.test/join/new"); err != nil {
		t.Fatalf("Retarget after Stop: %v", err)
	}
}

func TestPreflightReadsTheGrantStateEvenOnANonZeroExit(t *testing.T) {
	
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
	
	mustWrite(t, w, "more output\n")
}

func TestWatcherAwaitReadyPrefersALateReadyOverTheExitSignal(t *testing.T) {
	w := newLauncherWatcher(func(string, ...any) {})
	exited := make(chan struct{})
	mustWrite(t, w, readyLine+"\n")
	close(exited)
	
	
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
