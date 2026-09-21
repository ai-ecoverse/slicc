//go:build darwin

package computer

import (
	"context"
	"os"
	"testing"
)

// Opt-in end-to-end against a REAL Sliccstart bundle (SLICCSTART_APP), skipped
// everywhere else. Every other test drives a shell stand-in.
func TestManualStartAgainstARealSliccstart(t *testing.T) {
	if os.Getenv("SLICC_E2E_SLICCSTART") == "" {
		t.Skip("set SLICC_E2E_SLICCSTART=1 and SLICCSTART_APP to run")
	}
	session, err := Start(context.Background(), Options{
		JoinURL: "https://tray.invalid/join/smoke",
		PairID:  "pair-e2e",
		Logf:    func(f string, a ...any) { t.Logf(f, a...) },
	})
	if err != nil {
		t.Fatalf("Start against the real launcher: %v", err)
	}
	t.Log("real Sliccstart reported ready")
	session.Stop()
	t.Log("real Sliccstart reaped")
}
