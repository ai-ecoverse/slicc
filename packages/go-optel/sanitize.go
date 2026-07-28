package optel

import (
	"net/url"
	"regexp"
)

// MaxMessageLength caps a sanitized error message, matching telemetry.ts's
// 200-character truncation for the webapp/extension `error` checkpoint.
const MaxMessageLength = 200

// urlPattern finds absolute http(s) URLs embedded in an error string.
var urlPattern = regexp.MustCompile(`https?://[^\s"'` + "`" + `)]+`)

// posixPathPattern collapses a multi-segment POSIX path to its first
// segment, mirroring telemetry.ts's `/(\/[a-z]+)(?:\/[^\s/]+)+/gi` ->
// "$1/.../" collapse (case-insensitive, so /Users/... and /home/... both
// hide everything past the first segment, including a username).
var posixPathPattern = regexp.MustCompile(`(?i)(/[a-zA-Z][a-zA-Z0-9_.-]*)(?:/[^\s/]+)+`)

// windowsPathPattern collapses a drive-rooted Windows path to its drive
// letter, e.g. `C:\Users\lars\secrets.txt` -> `C:\...`.
var windowsPathPattern = regexp.MustCompile(`(?i)[A-Z]:\\[^\s"']+`)

// Sanitize reduces an error message to a privacy-safe form before it is
// allowed anywhere near a Sample()/ReportError() call.
//
// This CLI is a WebRTC follower that dials a leader join URL carrying a
// bearer token in its path (https://…/join/<token>) and executes
// leader-issued shell commands on the user's machine (`follow`). Go's
// net/http and net/url error types routinely embed the full request URL —
// including that token — in their Error() string (e.g. `Get
// "https://.../join/<token>": dial tcp: ...`), and OS-level errors just as
// routinely embed the user's home directory (which, on most platforms,
// contains their login name). Both are effectively credentials or PII for
// this CLI's threat model, which is why the redaction order below is
// URLs-and-paths-first, truncate-last: a URL or path is stripped in full
// before any truncation could leave a partial (still-sensitive) fragment
// on the wire.
//
//  1. Every absolute http(s) URL is reduced to just its scheme+host — the
//     entire path/query/fragment (where a join-URL token lives) is
//     dropped, never partially truncated.
//  2. Absolute POSIX and Windows paths are collapsed to their first
//     segment / drive letter, matching telemetry.ts's `/<root>/.../`
//     convention.
//  3. The result is truncated to MaxMessageLength runes.
func Sanitize(msg string) string {
	redacted := urlPattern.ReplaceAllStringFunc(msg, redactURL)
	redacted = posixPathPattern.ReplaceAllString(redacted, "$1/...")
	redacted = windowsPathPattern.ReplaceAllStringFunc(redacted, redactWindowsPath)
	return truncate(redacted, MaxMessageLength)
}

// redactURL keeps only scheme://host from a matched URL, dropping path,
// query, and fragment entirely (where a join-URL bearer token lives). An
// unparseable match (should not happen given the pattern) is redacted
// wholesale.
func redactURL(match string) string {
	parsed, err := url.Parse(match)
	if err != nil || parsed.Host == "" {
		return "<url>"
	}
	return parsed.Scheme + "://" + parsed.Host + "/..."
}

// redactWindowsPath keeps only the drive letter from a matched Windows
// path.
func redactWindowsPath(match string) string {
	if len(match) < 2 {
		return `<path>`
	}
	return match[:2] + `\...`
}

// truncate caps s to limit runes (never splitting a multi-byte rune).
func truncate(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit])
}
