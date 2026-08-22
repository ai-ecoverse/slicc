package tray

import (
	"errors"
	"testing"
)

func TestAttachErrorString(t *testing.T) {
	err := &AttachError{Code: AttachCodeSupersededChainExhausted, Message: "moved too far"}
	want := "tray attach failed (TRAY_SUPERSEDED_CHAIN_EXHAUSTED): moved too far"
	if err.Error() != want {
		t.Fatalf("Error() = %q, want %q", err.Error(), want)
	}
}

func TestIsSupersedeChainExhausted(t *testing.T) {
	if !IsSupersedeChainExhausted(&AttachError{Code: AttachCodeSupersededChainExhausted}) {
		t.Fatal("expected chain exhausted")
	}
	if IsSupersedeChainExhausted(&AttachError{Code: AttachCodeSupersededMissingJoin}) {
		t.Fatal("missing join should not match chain exhausted")
	}
	if IsSupersedeChainExhausted(errors.New("other")) {
		t.Fatal("unrelated error should not match")
	}
}

func TestIsSupersedeMissingJoin(t *testing.T) {
	if !IsSupersedeMissingJoin(&AttachError{Code: AttachCodeSupersededMissingJoin}) {
		t.Fatal("expected missing join")
	}
	if IsSupersedeMissingJoin(&AttachError{Code: AttachCodeSupersededChainExhausted}) {
		t.Fatal("chain exhausted should not match missing join")
	}
}
