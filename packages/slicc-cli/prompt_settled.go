package main

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)

// allSettled tracks every unit on the leader for `prompt --allsettled`.
//
// The cone can end its turn while scoops it started are still working, and
// wake again when they report back. A benchmark that stops reading at the
// first turn end scores an unfinished answer, or finds the agent still
// spending afterwards. With --allsettled, the prompt ends only when the
// prompted turn has ended, no unit is `processing`, and nothing from any unit
// has arrived for the quiet period.
type allSettled struct {
	mu    sync.Mutex
	quiet time.Duration
	// busy holds units whose last status was `processing`. An unnamed status
	// (an older leader) is keyed "".
	busy map[string]bool
	// last is when any unit last said anything: a status or an agent event.
	last time.Time
	// ended is set once the prompted turn has ended at least once.
	ended bool
}

func newAllSettled(quiet time.Duration, now time.Time) *allSettled {
	return &allSettled{quiet: quiet, busy: map[string]bool{}, last: now}
}

// observe records a frame from any unit, before the prompt's own filtering.
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

// applyRoster reads a `scoops.list` snapshot. A unit already `working` (or
// still `initializing`) when the prompt connects appears only here, before
// any status frame of its own. A unit that left the roster stops counting: a
// dropped scoop never sends its own `ready`. A leader without `state` leaves
// the statuses as they are.
//
// The leader re-broadcasts this snapshot every 5 s, so it is state, not
// activity: only a change restarts the quiet period — a unit turning busy,
// or a busy unit turning idle or leaving. Counting every snapshot kept each
// bench prompt open until its timeout.
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
			if !a.busy[s.Jid] {
				a.busy[s.Jid] = true
				a.last = now
			}
		case "idle", "broken":
			if a.busy[s.Jid] {
				delete(a.busy, s.Jid)
				a.last = now
			}
		}
	}
	for jid := range a.busy {
		if jid != "" && !present[jid] {
			delete(a.busy, jid)
			a.last = now
		}
	}
}

// turnEnded marks the prompted turn as ended (a `turn_end` or a settled
// ready). The cone may resume later; that does not undo it.
func (a *allSettled) turnEnded() {
	a.mu.Lock()
	a.ended = true
	a.mu.Unlock()
}

// settled reports whether everything has been quiet for the whole period, and
// if not, how long to wait before asking again (0 = something is still busy).
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
