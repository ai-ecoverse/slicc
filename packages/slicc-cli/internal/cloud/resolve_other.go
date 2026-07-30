//go:build !darwin

package cloud

// iCloud key-value storage is an Apple-only API, so tray-session discovery is
// unavailable off macOS. The verbs still compile and dispatch everywhere; they
// just report ErrUnsupported.

// LocateExecutable reports that iCloud tray-session discovery is unavailable off
// macOS.
func LocateExecutable() (string, error) {
	return "", ErrUnsupported
}

// List reports that iCloud tray-session discovery is unavailable off macOS.
func List(_ bool) ([]Session, error) {
	return nil, ErrUnsupported
}
