//go:build darwin

package cloud

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// bundleID is Sliccstart's macOS bundle identifier, used to locate the app.
const bundleID = "com.slicc.sliccstart"

// executableRelPath is where the launcher binary lives inside the .app bundle.
const executableRelPath = "Contents/MacOS/Sliccstart"

// LocateExecutable resolves the Sliccstart launcher binary that can read the
// iCloud store (it holds the KVS entitlement). Resolution order: the
// SLICCSTART_APP override, Spotlight (mdfind by bundle id), then the standard
// install locations.
func LocateExecutable() (string, error) {
	if override := os.Getenv("SLICCSTART_APP"); override != "" {
		return executableIn(override)
	}
	if app := mdfindApp(); app != "" {
		if exe, err := executableIn(app); err == nil {
			return exe, nil
		}
	}
	candidates := []string{"/Applications/Sliccstart.app"}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, "Applications", "Sliccstart.app"))
	}
	for _, app := range candidates {
		if exe, err := executableIn(app); err == nil {
			return exe, nil
		}
	}
	return "", fmt.Errorf("cannot find Sliccstart.app (install it, or set SLICCSTART_APP to the app or its executable)")
}

// executableIn maps an .app path (or a direct executable path) to the launcher
// binary and verifies it exists.
func executableIn(path string) (string, error) {
	exe := path
	if strings.HasSuffix(path, ".app") {
		exe = filepath.Join(path, executableRelPath)
	}
	info, err := os.Stat(exe)
	if err != nil {
		return "", fmt.Errorf("no Sliccstart executable at %q: %w", exe, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%q is a directory, not the Sliccstart executable", exe)
	}
	return exe, nil
}

func mdfindApp() string {
	out, err := exec.Command("mdfind", fmt.Sprintf("kMDItemCFBundleIdentifier == %q", bundleID)).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasSuffix(line, ".app") {
			return line
		}
	}
	return ""
}

// List runs `Sliccstart --list-sessions [--reveal-urls]` and parses the JSON it
// prints. A non-zero exit (e.g. reveal consent denied) surfaces the launcher's
// stderr guidance verbatim.
func List(reveal bool) ([]Session, error) {
	exe, err := LocateExecutable()
	if err != nil {
		return nil, err
	}
	args := []string{"--list-sessions"}
	if reveal {
		args = append(args, "--reveal-urls")
	}
	cmd := exec.Command(exe, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("%s", msg)
		}
		return nil, fmt.Errorf("running Sliccstart --list-sessions: %w", err)
	}
	return ParseSessions(stdout.Bytes())
}
