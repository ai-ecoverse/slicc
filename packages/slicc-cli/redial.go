package main

import (
	"errors"
	"io"
	"strings"
)



type dialFailed struct{ err error }

func (e *dialFailed) Error() string { return e.err.Error() }
func (e *dialFailed) Unwrap() error { return e.err }



func undeliveredSend(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.ErrClosedPipe) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "closed pipe") ||
		strings.Contains(msg, "closed channel") ||
		strings.Contains(msg, "data channel not open")
}





func dialAndSend[C interface{ Close() }](dial func() (C, error), send func(C) error) (C, error) {
	var zero C
	for attempt := 0; attempt < 2; attempt++ {
		conn, err := dial()
		if err != nil {
			wrapped := &dialFailed{err: err}
			if attempt == 0 && undeliveredSend(err) {
				debugLogf("tray: send failed before the request was delivered (%v); redialing", err)
				continue
			}
			return zero, wrapped
		}
		if err := send(conn); err != nil {
			conn.Close()
			if attempt == 0 && undeliveredSend(err) {
				debugLogf("tray: request frame was not delivered (%v); redialing", err)
				continue
			}
			return zero, err
		}
		return conn, nil
	}
	return zero, errors.New("tray: redial exhausted")
}
