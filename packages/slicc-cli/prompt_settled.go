package main

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)









type allSettled struct {
	mu    sync.Mutex
	quiet time.Duration
	
	
	busy map[string]bool
	
	last time.Time
	
	ended bool
}

func newAllSettled(quiet time.Duration, now time.Time) *allSettled {
	return &allSettled{quiet: quiet, busy: map[string]bool{}, last: now}
}


func (a *allSettled) observe(typ string, raw []byte, now time.Time) {
	switch typ {
	case protocol.TypeStatus:
		var s protocol.Status
		if json.Unmarshal(raw, &s) != nil {
			return
		}
		a.mu.Lock()
		if s.ScoopStatus == protocol.ScoopStatusProcessing {
			a.busy[s.ScoopJid] = true
		} else {
			delete(a.busy, s.ScoopJid)
		}
		a.last = now
		a.mu.Unlock()
	case protocol.TypeAgentEvent:
		a.mu.Lock()
		a.last = now
		a.mu.Unlock()
	case "scoops.list":
		a.applyRoster(raw, now)
	}
}






func (a *allSettled) applyRoster(raw []byte, now time.Time) {
	var msg struct {
		Scoops []struct {
			Jid   string `json:"jid"`
			State string `json:"state"`
		} `json:"scoops"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return
	}
	present := map[string]bool{}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, s := range msg.Scoops {
		present[s.Jid] = true
		switch s.State {
		case "working", "initializing":
			a.busy[s.Jid] = true
		case "idle", "broken":
			delete(a.busy, s.Jid)
		}
	}
	for jid := range a.busy {
		if jid != "" && !present[jid] {
			delete(a.busy, jid)
		}
	}
	a.last = now
}



func (a *allSettled) turnEnded() {
	a.mu.Lock()
	a.ended = true
	a.mu.Unlock()
}



func (a *allSettled) settled(now time.Time) (bool, time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.ended || len(a.busy) > 0 {
		return false, 0
	}
	if remaining := a.quiet - now.Sub(a.last); remaining > 0 {
		return false, remaining
	}
	return true, 0
}
