//go:build darwin

package computer

import (
	"context"
	"errors"
	"os"
	"testing"
)

// Opt-in end-to-end checks against a REAL Sliccstart bundle, skipped everywhere
// else — every other test drives a shell stand-in, and the stand-in can only
// prove what the Go side does with the lines it is fed.
//
//	SLICC_E2E_SLICCSTART=1 SLICCSTART_APP=<path to Sliccstart.app> go test ./internal/computer/ -run Manual -v
//
// Add SLICC_E2E_JOIN_URL=<a live leader's join URL> to also exercise a real
// attach; it may raise the Screen Recording / Accessibility prompts.
func requireRealLauncher(t *testing.T) {
	t.Helper()
	if os.Getenv("SLICC_E2E_SLICCSTART") == "" {
		t.Skip("set SLICC_E2E_SLICCSTART=1 and SLICCSTART_APP to run")
	}
}

// An unreachable leader is an attach failure carrying the launcher's reason —
// not success (the pre-review behaviour, which let --computer=require continue
// without a screen) and not "outdated launcher".
func TestManualRealLauncherReportsAnUnreachableLeader(t *testing.T) {
	requireRealLauncher(t)
	_, err := Start(context.Background(), Options{
		JoinURL: "https://tray.invalid/join/smoke",
		PairID:  "pair-e2e",
		Logf:    func(f string, a ...any) { t.Logf(f, a...) },
	})
	if !errors.Is(err, ErrAttachFailed) || errors.Is(err, ErrOutdatedLauncher) {
		t.Fatalf("Start = %v, want ErrAttachFailed (and not ErrOutdatedLauncher)", err)
	}
	t.Logf("reported: %v", err)
}

func TestManualRealLauncherAttachesToALiveLeader(t *testing.T) {
	requireRealLauncher(t)
	joinURL := os.Getenv("SLICC_E2E_JOIN_URL")
	if joinURL == "" {
		t.Skip("set SLICC_E2E_JOIN_URL to a live leader's join URL")
	}
	session, err := Start(context.Background(), Options{
		JoinURL: joinURL,
		PairID:  "pair-e2e",
		Logf:    func(f string, a ...any) { t.Logf(f, a...) },
	})
	if err != nil {
		t.Fatalf("Start against a live leader: %v", err)
	}
	t.Log("real Sliccstart attached")
	session.Stop()
	t.Log("real Sliccstart reaped")
}
