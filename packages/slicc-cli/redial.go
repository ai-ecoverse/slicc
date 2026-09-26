package main

import (
	"errors"
	"io"
	"strings"
)

// dialFailed marks an error from opening the follower connection, as opposed
// to a later send of the call's request frame.
type dialFailed struct{ err error }

func (e *dialFailed) Error() string { return e.err.Error() }
func (e *dialFailed) Unwrap() error { return e.err }

// undeliveredSend is a SendText that failed because the data channel was
// already closed. Nothing from that frame reached the leader.
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

// dialAndSend opens a follower connection and sends the call's request frame.
// When that first send fails because the channel is already closed, nothing
// ran on the leader, so the whole dial is tried once more. A send that
// returned nil is never repeated: the command may be running.
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
