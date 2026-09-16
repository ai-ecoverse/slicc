package optel

import (
	"net/url"
	"regexp"
)

const MaxMessageLength = 200

var urlPattern = regexp.MustCompile(`https?://[^\s"'` + "`" + `)]+`)

var posixPathPattern = regexp.MustCompile(`(?i)(/[a-zA-Z][a-zA-Z0-9_.-]*)(?:/[^\s/]+)+`)

var windowsPathPattern = regexp.MustCompile(`(?i)[A-Z]:\\[^\s"']+`)

func Sanitize(msg string) string {
	redacted := urlPattern.ReplaceAllStringFunc(msg, redactURL)
	redacted = posixPathPattern.ReplaceAllString(redacted, "$1/...")
	redacted = windowsPathPattern.ReplaceAllStringFunc(redacted, redactWindowsPath)
	return truncate(redacted, MaxMessageLength)
}

func redactURL(match string) string {
	parsed, err := url.Parse(match)
	if err != nil || parsed.Host == "" {
		return "<url>"
	}
	return parsed.Scheme + "://" + parsed.Host + "/..."
}

func redactWindowsPath(match string) string {
	if len(match) < 2 {
		return `<path>`
	}
	return match[:2] + `\...`
}

func truncate(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit])
}
