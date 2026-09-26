package tray

import (
	"sync"

	"github.com/ai-ecoverse/slicc-cli/internal/signaling"
)








type trickleQueue struct {
	mu      sync.Mutex
	open    bool
	pending []signaling.IceCandidate
}


func (q *trickleQueue) pushOrSend(cand signaling.IceCandidate, send func(signaling.IceCandidate)) {
	q.pushOrSendIf(cand, func() bool { return true }, send)
}







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
