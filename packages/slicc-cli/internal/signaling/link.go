package signaling

import (
	"net/http"
	"net/url"
	"strings"
)





const SuccessorVersionRel = "successor-version"
















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
		
		
		for _, token := range strings.Fields(value) {
			if strings.EqualFold(token, SuccessorVersionRel) {
				return true
			}
		}
	}
	return false
}


func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
