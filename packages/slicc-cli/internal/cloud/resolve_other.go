//go:build !darwin

package cloud







func LocateExecutable() (string, error) {
	return "", ErrUnsupported
}


func List(_ bool) ([]Session, error) {
	return nil, ErrUnsupported
}
