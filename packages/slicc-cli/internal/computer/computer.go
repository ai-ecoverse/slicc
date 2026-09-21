// Package computer brings native macOS screen capture and input along with a
// `slicc <join-url> follow` session (issue #3260).
//
// The CLI cannot capture a screen itself: it builds with CGO_ENABLED=0, so
// ScreenCaptureKit and CGEvent are both out of reach. It also must not try —
// macOS attributes a TCC grant to the *responsible* process, which for a bare
// binary is the terminal that launched it, so even a cgo build would ask the
// user to trust Terminal.app rather than SLICC.
//
// So `--computer` shells out, exactly as `internal/cloud` already does for the
// iCloud session list: it starts the signed Sliccstart bundle in a headless
// `--computer-follow` mode pointed at the same join URL, and keeps it alive for
// the session. Prompts then attribute to Sliccstart, and the grant survives a
// CLI restart.
//
// Both peers carry the same `pairId` on `hello`, so the leader folds them into
// one roster entry holding `exec` (this CLI) and `computer` (the launcher)
// instead of showing the Mac twice.
package computer

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrUnsupported is returned off macOS, where there is no Sliccstart bundle and
// no ScreenCaptureKit to reach.
var ErrUnsupported = errors.New("native computer capture is macOS-only")

// Mode is what `--computer` was asked to do when the launcher cannot be brought
// up — the difference between "nice to have" and "the point of this session".
type Mode int

const (
	// ModeOff is the default: no launcher, `follow` behaves exactly as before.
	ModeOff Mode = iota
	// ModeBestEffort reports the failure and follows on without native capture.
	ModeBestEffort
	// ModeRequire treats the failure as fatal, so a script that needs a screen
	// does not silently connect as an exec-only follower.
	ModeRequire
)

// ParseMode reads the `--computer[=require]` argument form. `ok` is false for a
// value the caller should reject rather than guess at.
func ParseMode(arg string) (mode Mode, ok bool) {
	name, value, hasValue := strings.Cut(arg, "=")
	if name != "--computer" {
		return ModeOff, false
	}
	if !hasValue {
		return ModeBestEffort, true
	}
	switch value {
	case "require":
		return ModeRequire, true
	case "auto", "":
		return ModeBestEffort, true
	default:
		return ModeOff, false
	}
}

// NewPairID mints the "these two peers are the same machine" token this CLI
// puts on its own `hello` and hands to the launcher as `--pair`.
//
// Minted here rather than reusing the CLI's runtime id because that id is a
// hub-assigned bootstrap id: it does not exist until the first attach, and it
// changes on every reconnect — while the launcher is spawned before the first
// connection and outlives all of them.
//
// Random rather than derived from hostname/pid so two `follow --computer`
// sessions on one Mac cannot collide into an ambiguous group (the leader folds
// nothing when a token names two exec peers, which would cost both of them
// native capture).
func NewPairID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("minting a computer pairing id: %w", err)
	}
	return "pair-" + hex.EncodeToString(buf), nil
}

// Grants is what `Sliccstart --computer-preflight` reports about this Mac.
type Grants struct {
	// ScreenRecording gates capture (`computer.native.capture`).
	ScreenRecording bool `json:"screenRecording"`
	// Accessibility gates input (`computer.native.input`), which additionally
	// needs `--allow-input` and the sudo approval hop on the leader.
	Accessibility bool `json:"accessibility"`
}

// Summary is the one-line grant state `follow --computer` prints at startup.
func (g Grants) Summary() string {
	return fmt.Sprintf("Screen Recording: %s · Accessibility: %s",
		grantWord(g.ScreenRecording), grantWord(g.Accessibility))
}

// Complete reports whether both TCC grants are in place.
func (g Grants) Complete() bool { return g.ScreenRecording && g.Accessibility }

func grantWord(granted bool) string {
	if granted {
		return "granted"
	}
	return "not granted"
}

// Options configures a launcher session.
type Options struct {
	// JoinURL is the leader the launcher should dial — the same one the CLI is
	// following.
	JoinURL string
	// PairID is the token both peers put on `hello`; see NewPairID.
	PairID string
	// Logf receives debug lines (the CLI's --debug logger). Optional.
	Logf func(format string, args ...any)
	// OnExit is called, from a background goroutine, when the launcher goes
	// away after attaching without being asked to — it gave up reconnecting,
	// or crashed. Not called for Stop or Retarget. Optional.
	OnExit func(reason string)
}
