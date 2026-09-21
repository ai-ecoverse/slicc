//go:build darwin

package computer

import (
	"context"
	"errors"
	"os"
	"testing"
)









func requireRealLauncher(t *testing.T) {
	t.Helper()
	if os.Getenv("SLICC_E2E_SLICCSTART") == "" {
		t.Skip("set SLICC_E2E_SLICCSTART=1 and SLICCSTART_APP to run")
	}
}




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
