package optel

import "testing"

func TestBuildReferer(t *testing.T) {
	cases := []struct {
		appID    string
		viewPath string
		want     string
	}{
		{"slicc-cli", "", "https://slicc-cli/"},
		{"slicc-cli", "/", "https://slicc-cli/"},
		{"slicc-cli", "/prompt", "https://slicc-cli/prompt"},
		{"slicc-cli", "prompt", "https://slicc-cli/prompt"},
	}
	for _, c := range cases {
		if got := BuildReferer(c.appID, c.viewPath); got != c.want {
			t.Errorf("BuildReferer(%q, %q) = %q, want %q", c.appID, c.viewPath, got, c.want)
		}
	}
}
