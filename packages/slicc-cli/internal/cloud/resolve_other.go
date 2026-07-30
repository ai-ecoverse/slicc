//go:build !darwin

package cloud

// iCloud key-value storage is an Apple-only API, so tray-session discovery is
// unavailable off macOS. The verbs still compile and dispatch everywhere; they
// just report ErrUnsupported.

func LocateExecutable() (string, error) {
	return "", ErrUnsupported
}

func List(_ bool) ([]Session, error) {
	return nil, ErrUnsupported
}
