//go:build darwin

package cloud

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)


const bundleID = "com.slicc.sliccstart"


const executableRelPath = "Contents/MacOS/Sliccstart"





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





const (
	listTimeout   = 20 * time.Second
	revealTimeout = 2 * time.Minute
)





func List(reveal bool) ([]Session, error) {
	exe, err := LocateExecutable()
	if err != nil {
		return nil, err
	}
	args := []string{"--list-sessions"}
	timeout := listTimeout
	if reveal {
		args = append(args, "--reveal-urls")
		timeout = revealTimeout
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("timed out after %s waiting for Sliccstart --list-sessions; update Sliccstart to a version that supports it", timeout)
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("%s", msg)
		}
		return nil, fmt.Errorf("running Sliccstart --list-sessions: %w", err)
	}
	return ParseSessions(stdout.Bytes())
}
