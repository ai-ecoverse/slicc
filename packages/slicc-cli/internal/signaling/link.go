package signaling

import (
	"net/http"
	"net/url"
	"strings"
)

// SuccessorVersionRel is the RFC 5829 relation the tray hub stamps on a
// superseded tray's response, pointing at the replacement tray's join URL.
// See packages/cloudflare-worker/src/links.ts and
// https://www.sliccy.ai/rel/successor-version.
const SuccessorVersionRel = "successor-version"

// SuccessorVersionFromLinkHeader pulls the `successor-version` target out of a
// response's RFC 8288 Link header(s).
//
// Deliberately narrow: the tray hub emits one well-formed link plus its
// standard rel set, so this handles the shapes that actually arrive —
// comma-separated link-values (commas inside quoted strings preserved),
// rel=token and rel="quoted token-list", repeated header instances — rather
// than reimplementing the full grammar. Kept behaviourally identical to
// successorVersionFromLinkHeader in packages/shared-ts/src/tray-signaling.ts;
// the pinned vectors in link_test.go are the same table as that package's
// tests/successor-version-link.test.ts.
//
// Returns "" when there is no such link. Relative references are rejected: a
// replacement tray is always absolute, and resolving one against the wrong
// base would dial an unusable address.
func SuccessorVersionFromLinkHeader(header http.Header) string {
	if header == nil {
		return ""
	}
	return successorVersionFromLinkValues(header.Values("Link"))
}

func successorVersionFromLinkValues(values []string) string {
	raw := strings.ReplaceAll(strings.Join(values, ", "), "\n", ", ")
	for _, value := range splitOutsideQuotes(raw, ',') {
		if !strings.HasPrefix(value, "<") {
			continue
		}
		uriEnd := strings.Index(value, ">")
		if uriEnd == -1 {
			continue
		}
		if !hasSuccessorVersionRel(value[uriEnd+1:]) {
			continue
		}
		target := strings.TrimSpace(value[1:uriEnd])
		parsed, err := url.Parse(target)
		if err != nil || !parsed.IsAbs() || parsed.Host == "" {
			return ""
		}
		return parsed.String()
	}
	return ""
}

// splitOutsideQuotes splits on sep at the top level — separators inside a
// quoted-string or an angle-bracketed URI-reference belong to the value, not
// the grammar. (A Link target may legitimately contain both:
// `<https://a/b;c?d,e>`.)
func splitOutsideQuotes(input string, sep byte) []string {
	var out []string
	start := 0
	inQuotes := false
	inAngle := false
	for i := 0; i < len(input); i++ {
		ch := input[i]
		if inQuotes {
			switch ch {
			case '\\':
				i++
			case '"':
				inQuotes = false
			}
			continue
		}
		switch {
		case ch == '"':
			inQuotes = true
		case ch == '<':
			inAngle = true
		case ch == '>':
			inAngle = false
		case ch == sep && !inAngle:
			out = append(out, strings.TrimSpace(input[start:i]))
			start = i + 1
		}
	}
	out = append(out, strings.TrimSpace(input[start:]))
	kept := out[:0]
	for _, v := range out {
		if v != "" {
			kept = append(kept, v)
		}
	}
	return kept
}

// hasSuccessorVersionRel reports whether a link-value's parameter list
// declares rel=successor-version.
func hasSuccessorVersionRel(params string) bool {
	for _, param := range splitOutsideQuotes(params, ';') {
		eq := strings.Index(param, "=")
		if eq == -1 {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(param[:eq]), "rel") {
			continue
		}
		value := strings.TrimSpace(param[eq+1:])
		if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			value = value[1 : len(value)-1]
		}
		// rel is a space-separated list of relation types, matched
		// case-insensitively.
		for _, token := range strings.Fields(value) {
			if strings.EqualFold(token, SuccessorVersionRel) {
				return true
			}
		}
	}
	return false
}

// firstNonEmpty returns the first non-empty string, or "".
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
