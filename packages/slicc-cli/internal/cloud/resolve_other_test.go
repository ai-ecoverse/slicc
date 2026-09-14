//go:build !darwin

package cloud

import (
	"errors"
	"testing"
)

func TestUnsupportedOffMacOS(t *testing.T) {
	if _, err := LocateExecutable(); !errors.Is(err, ErrUnsupported) {
		t.Errorf("LocateExecutable off macOS: got %v, want ErrUnsupported", err)
	}
	if _, err := List(true); !errors.Is(err, ErrUnsupported) {
		t.Errorf("List off macOS: got %v, want ErrUnsupported", err)
	}
}
