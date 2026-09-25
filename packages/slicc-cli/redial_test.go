package main

import (
	"errors"
	"io"
	"testing"
)

type redialConn struct{ closed int }

func (c *redialConn) Close() { c.closed++ }

func TestDialAndSendRedialsWhenFirstSendFails(t *testing.T) {
	dials := 0
	sends := 0
	conn, err := dialAndSend(
		func() (*redialConn, error) {
			dials++
			return &redialConn{}, nil
		},
		func(_ *redialConn) error {
			sends++
			if sends == 1 {
				return io.ErrClosedPipe
			}
			return nil
		},
	)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if dials != 2 || sends != 2 {
		t.Fatalf("dials=%d sends=%d, want 2 and 2", dials, sends)
	}
	if conn == nil || conn.closed != 0 {
		t.Fatalf("live conn = %+v", conn)
	}
}

func TestDialAndSendRedialsWhenTheDialSendFails(t *testing.T) {
	dials := 0
	conn, err := dialAndSend(
		func() (*redialConn, error) {
			dials++
			if dials == 1 {
				return nil, errors.New("io: read/write on closed pipe")
			}
			return &redialConn{}, nil
		},
		func(_ *redialConn) error { return nil },
	)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if dials != 2 || conn == nil {
		t.Fatalf("dials=%d conn=%v", dials, conn)
	}
}

func TestDialAndSendDoesNotRetryAfterASuccessfulSend(t *testing.T) {
	dials := 0
	conn, err := dialAndSend(
		func() (*redialConn, error) {
			dials++
			return &redialConn{}, nil
		},
		func(_ *redialConn) error { return nil },
	)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if dials != 1 || conn == nil {
		t.Fatalf("dials=%d conn=%v, want one successful dial", dials, conn)
	}
}

func TestDialAndSendDoesNotRetryADeliveredFrame(t *testing.T) {
	// A non-channel error after a successful dial is the leader rejecting the
	// frame, or a failure once the write was accepted. Either way it ran, or
	// might have.
	dials := 0
	_, err := dialAndSend(
		func() (*redialConn, error) {
			dials++
			return &redialConn{}, nil
		},
		func(_ *redialConn) error { return errors.New("leader rejected the command") },
	)
	if err == nil || dials != 1 {
		t.Fatalf("err=%v dials=%d, want the rejection and no redial", err, dials)
	}
}
