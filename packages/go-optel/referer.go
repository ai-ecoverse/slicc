package optel

import "strings"

// DefaultCollectBaseURL matches helix-rum-js (https://rum.hlx.page/).
const DefaultCollectBaseURL = "https://rum.hlx.page/"

// BuildReferer constructs the helix-rum-js `referer` string from an app id
// and a view path.
//
// In helix-rum-js, referer = window.location.origin + window.location.pathname.
// A headless CLI has no URL, so — exactly like swift-optel's RUMReferer — the
// app id substitutes for the hostname:
//
//	https://{appID}{viewPath}
//
// viewPath is normalized to always begin with "/" so the result mirrors a
// browser origin+pathname value even when callers pass "" or a relative path.
func BuildReferer(appID, viewPath string) string {
	var normalized string
	switch {
	case viewPath == "":
		normalized = "/"
	case strings.HasPrefix(viewPath, "/"):
		normalized = viewPath
	default:
		normalized = "/" + viewPath
	}
	return "https://" + appID + normalized
}
