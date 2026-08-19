package ui

import (
	"os"
	"path/filepath"
	"testing"
)

// envMap builds an Env from a map, so a case declares only what it sets.
func envMap(vars map[string]string) Env {
	return func(key string) (string, bool) {
		v, ok := vars[key]
		return v, ok
	}
}

// notATerminal is a regular file: a stream that must never be decorated.
func notATerminal(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Create(filepath.Join(t.TempDir(), "out"))
	if err != nil {
		t.Fatalf("temp file: %v", err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func TestDetectRedirectedStreamIsPlain(t *testing.T) {
	mode := Detect(notATerminal(t), envMap(map[string]string{"TERM": "xterm-256color"}))
	if !mode.Plain() {
		t.Fatalf("a redirected stream must be plain, got %+v", mode)
	}
}

func TestDetectNilFileIsPlain(t *testing.T) {
	if !Detect(nil, envMap(nil)).Plain() {
		t.Fatal("a nil stream must be plain")
	}
}

func TestDetectEnvOverrides(t *testing.T) {
	f := notATerminal(t)
	cases := []struct {
		name      string
		env       map[string]string
		wantColor bool
	}{
		{"FORCE_COLOR paints a redirected stream", map[string]string{"FORCE_COLOR": "1"}, true},
		{"CLICOLOR_FORCE too", map[string]string{"CLICOLOR_FORCE": "1"}, true},
		{"FORCE_COLOR=0 is not forcing", map[string]string{"FORCE_COLOR": "0"}, false},
		{"TERM=dumb beats FORCE_COLOR", map[string]string{"FORCE_COLOR": "1", "TERM": "dumb"}, false},
		{"SLICC_NO_TUI beats FORCE_COLOR", map[string]string{"FORCE_COLOR": "1", EnvNoTUI: "1"}, false},
		{"SLICC_NO_TUI=0 does not disable", map[string]string{"FORCE_COLOR": "1", EnvNoTUI: "0"}, true},
		{"NO_COLOR drops color", map[string]string{"FORCE_COLOR": "1", "NO_COLOR": ""}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mode := Detect(f, envMap(tc.env))
			if mode.Color != tc.wantColor {
				t.Errorf("Color = %v, want %v (mode %+v)", mode.Color, tc.wantColor, mode)
			}
			// Cursor control is never emitted into something that is not a
			// terminal, whatever the environment claims.
			if mode.Sticky {
				t.Error("a redirected stream must never be sticky")
			}
		})
	}
}

func TestDetectNoColorKeepsBarOff(t *testing.T) {
	mode := Detect(notATerminal(t), envMap(map[string]string{"NO_COLOR": "1", "FORCE_COLOR": ""}))
	if mode.Color {
		t.Error("NO_COLOR must drop color")
	}
}

func TestUnicodeCapable(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"UTF-8 locale", map[string]string{"LANG": "en_US.UTF-8"}, true},
		{"utf8 spelling", map[string]string{"LC_CTYPE": "de_DE.utf8"}, true},
		{"LC_ALL wins", map[string]string{"LC_ALL": "C", "LANG": "en_US.UTF-8"}, false},
		{"legacy code page", map[string]string{"LANG": "en_US.ISO8859-1"}, false},
		{"windows terminal", map[string]string{"WT_SESSION": "abc"}, true},
		{"nothing known", map[string]string{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := unicodeCapable(envMap(tc.env)); got != tc.want {
				t.Errorf("unicodeCapable = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestWidth(t *testing.T) {
	f := notATerminal(t)
	if got := Width(f, envMap(map[string]string{"COLUMNS": "133"})); got != 133 {
		t.Errorf("COLUMNS override = %d, want 133", got)
	}
	if got := Width(f, envMap(map[string]string{"COLUMNS": "not-a-number"})); got != DefaultWidth {
		t.Errorf("garbage COLUMNS = %d, want the default %d", got, DefaultWidth)
	}
	if got := Width(f, envMap(nil)); got != DefaultWidth {
		t.Errorf("non-terminal width = %d, want the default %d", got, DefaultWidth)
	}
}

func TestAtoiSafe(t *testing.T) {
	cases := map[string]int{"80": 80, " 120 ": 120, "": 0, "12a": 0, "-5": 0, "999999999": 0}
	for in, want := range cases {
		if got := atoiSafe(in); got != want {
			t.Errorf("atoiSafe(%q) = %d, want %d", in, got, want)
		}
	}
}
