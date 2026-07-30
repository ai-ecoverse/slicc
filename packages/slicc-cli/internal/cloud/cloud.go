// Package cloud reads active SLICC tray sessions that the macOS launcher
// (Sliccstart) advertises over the user's iCloud key-value store, so the
// headless CLI can join a leader by discovery instead of a hand-copied join
// URL.
//
// iCloud KVS is an Apple-only API and the store is readable only by the signed,
// iCloud-entitled Sliccstart binary, so this package shells out to
// `Sliccstart --list-sessions` (see resolve_darwin.go) rather than reading
// iCloud directly. The join URL is a bearer secret, so Sliccstart redacts it
// unless `--reveal-urls` is passed and the user approves. Everything in this
// file is pure (parsing, selection, formatting) and platform-independent.
package cloud

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ErrUnsupported is returned by List/LocateExecutable on non-macOS platforms.
var ErrUnsupported = errors.New("iCloud tray sessions are only available on macOS")

// Session mirrors the JSON `Sliccstart --list-sessions` emits (see
// TraySessionCLI.SessionDTO in packages/swift-launcher). JoinURL is present only
// when the session was listed with --reveal-urls and the user approved.
type Session struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	DeviceID   string    `json:"deviceId"`
	DeviceName string    `json:"deviceName"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
	JoinURL    string    `json:"joinUrl,omitempty"`
}

// ParseSessions decodes the launcher's JSON array.
func ParseSessions(data []byte) ([]Session, error) {
	var sessions []Session
	if err := json.Unmarshal(data, &sessions); err != nil {
		return nil, fmt.Errorf("parsing session list: %w", err)
	}
	return sessions, nil
}

// Selector picks one session from the list. IDPrefix (a leading substring of
// the opaque session id) wins when set; otherwise Index selects into the
// newest-first ordering (0 = most recently seen).
type Selector struct {
	Index    int
	IDPrefix string
}

// ParseSelector consumes leading `--index N` / `--session <id-prefix>` options
// (and their `=` forms, plus a `--` terminator) and returns the remaining args
// verbatim, so verb-specific arguments (runner argv, prompt text) pass through
// untouched.
func ParseSelector(args []string) (Selector, []string, error) {
	sel := Selector{}
	for len(args) > 0 {
		switch {
		case args[0] == "--":
			return sel, args[1:], nil
		case args[0] == "--index" && len(args) > 1:
			n, err := strconv.Atoi(args[1])
			if err != nil {
				return sel, nil, fmt.Errorf("invalid --index %q: %w", args[1], err)
			}
			sel.Index = n
			args = args[2:]
		case strings.HasPrefix(args[0], "--index="):
			raw := strings.TrimPrefix(args[0], "--index=")
			n, err := strconv.Atoi(raw)
			if err != nil {
				return sel, nil, fmt.Errorf("invalid --index %q: %w", raw, err)
			}
			sel.Index = n
			args = args[1:]
		case args[0] == "--session" && len(args) > 1:
			sel.IDPrefix = args[1]
			args = args[2:]
		case strings.HasPrefix(args[0], "--session="):
			sel.IDPrefix = strings.TrimPrefix(args[0], "--session=")
			args = args[1:]
		case args[0] == "--index" || args[0] == "--session":
			// A bare selector flag with no value must not be silently treated
			// as verb argument (e.g. runner argv or prompt text).
			return sel, nil, fmt.Errorf("missing value for %s", args[0])
		default:
			return sel, args, nil
		}
	}
	return sel, args, nil
}

// Select applies a Selector to the sessions, newest first. It sorts defensively
// so index semantics hold regardless of input order.
func Select(sessions []Session, sel Selector) (Session, error) {
	if len(sessions) == 0 {
		return Session{}, errors.New("no active tray sessions found in iCloud")
	}

	ordered := make([]Session, len(sessions))
	copy(ordered, sessions)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].LastSeenAt.After(ordered[j].LastSeenAt)
	})

	if sel.IDPrefix != "" {
		var matches []Session
		for _, s := range ordered {
			if strings.HasPrefix(s.ID, sel.IDPrefix) {
				matches = append(matches, s)
			}
		}
		switch len(matches) {
		case 0:
			return Session{}, fmt.Errorf("no session matches id prefix %q", sel.IDPrefix)
		case 1:
			return matches[0], nil
		default:
			return Session{}, fmt.Errorf("id prefix %q matches %d sessions; use a longer prefix", sel.IDPrefix, len(matches))
		}
	}

	if sel.Index < 0 || sel.Index >= len(ordered) {
		return Session{}, fmt.Errorf("session index %d out of range (%d session(s) available)", sel.Index, len(ordered))
	}
	return ordered[sel.Index], nil
}

// FormatTable renders the sessions as a human-readable table (join URLs are
// never shown here). now is passed in so the age column is deterministic.
func FormatTable(sessions []Session, now time.Time) string {
	if len(sessions) == 0 {
		return "No active tray sessions found in iCloud.\n"
	}

	ordered := make([]Session, len(sessions))
	copy(ordered, sessions)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].LastSeenAt.After(ordered[j].LastSeenAt)
	})

	var b strings.Builder
	fmt.Fprintf(&b, "%-3s  %-12s  %-24s  %-20s  %s\n", "#", "ID", "LABEL", "DEVICE", "AGE")
	for i, s := range ordered {
		fmt.Fprintf(&b, "%-3d  %-12s  %-24s  %-20s  %s\n",
			i, shortID(s.ID), truncate(s.Label, 24), truncate(s.DeviceName, 20), formatAge(now.Sub(s.LastSeenAt)))
	}
	return b.String()
}

func shortID(id string) string {
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}

// truncate shortens s to at most width runes (not bytes), so multibyte labels
// and device names are never cut mid-UTF-8-sequence.
func truncate(s string, width int) string {
	runes := []rune(s)
	if len(runes) <= width {
		return s
	}
	if width <= 1 {
		return string(runes[:width])
	}
	return string(runes[:width-1]) + "…"
}

// formatAge renders a coarse "time since last seen" label.
func formatAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}
