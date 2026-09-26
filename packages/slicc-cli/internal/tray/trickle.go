package tray

import (
	"sync"

	"github.com/ai-ecoverse/slicc-cli/internal/signaling"
)

// trickleQueue holds ICE candidates that gather before the peer has a remote
// description (inbound) or before the local description has been posted
// (outbound). Chrome and pion both reject a candidate that arrives first, and
// the candidate they drop is the host one a same-machine dial needs.
//
// Gathering callbacks run on pion's goroutines while the dial loop posts the
// answer, so the queue is safe for those two callers. send runs unlocked.
type trickleQueue struct {
	mu      sync.Mutex
	open    bool
	pending []signaling.IceCandidate
}

// pushOrSend queues cand until release, then sends it immediately.
func (q *trickleQueue) pushOrSend(cand signaling.IceCandidate, send func(signaling.IceCandidate)) {
	q.pushOrSendIf(cand, func() bool { return true }, send)
}

// pushOrSendIf is pushOrSend, but accept runs under the queue lock together
// with the decision to queue or drop. A peer swap cannot land between the
// acceptance check and the insert: reset takes this same lock. accept must
// not acquire a lock that reset or release holds while taking this one.
// Conn's accept locks Conn.mu, and Conn never holds Conn.mu while calling
// reset or release.
func (q *trickleQueue) pushOrSendIf(cand signaling.IceCandidate, accept func() bool, send func(signaling.IceCandidate)) {
	q.mu.Lock()
	if !accept() {
		q.mu.Unlock()
		return
	}
	if !q.open {
		q.pending = append(q.pending, cand)
		q.mu.Unlock()
		return
	}
	q.mu.Unlock()
	send(cand)
}

// release delivers everything queued so far and sends later candidates immediately.
func (q *trickleQueue) release(send func(signaling.IceCandidate)) {
	q.mu.Lock()
	q.open = true
	pending := q.pending
	q.pending = nil
	q.mu.Unlock()
	for _, cand := range pending {
		send(cand)
	}
}

func (q *trickleQueue) reset() {
	q.mu.Lock()
	q.open = false
	q.pending = nil
	q.mu.Unlock()
}
