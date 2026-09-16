package optel

import "strings"

const DefaultCollectBaseURL = "https://rum.hlx.page/"

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
