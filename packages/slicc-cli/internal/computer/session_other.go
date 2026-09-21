//go:build !darwin

package computer

import "context"

// Screen Recording / Accessibility (TCC) and the signed Sliccstart bundle that
// owns them are Apple-only, so `--computer` reports ErrUnsupported everywhere
// else. The flag still parses and dispatches on every platform — a script that
// passes it on Linux gets one clear line, not an unknown-option failure.

// Session is the non-macOS stand-in; nothing is ever started, so stopping and
// retargeting are no-ops a caller can invoke unconditionally.
type Session struct{}

// Preflight reports that native computer capture is unavailable off macOS.
func Preflight(_ context.Context) (Grants, error) { return Grants{}, ErrUnsupported }

// Start reports that native computer capture is unavailable off macOS.
func Start(_ context.Context, _ Options) (*Session, error) { return nil, ErrUnsupported }

// Retarget is a no-op off macOS.
func (s *Session) Retarget(_ context.Context, _ string) error { return nil }

// Stop is a no-op off macOS.
func (s *Session) Stop() {}
