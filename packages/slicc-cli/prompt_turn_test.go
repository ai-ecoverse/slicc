package main

import (
	"testing"
	"time"
)

func TestPromptTurnIgnoresNamedReadyBeforeTheUnitIsKnown(t *testing.T) {
	p := &promptTurn{}
	now := time.Now()
	if p.status("processing", "cone-1", now) {
		t.Fatal("processing armed a candidate")
	}
	if p.status("ready", "sports", now) {
		t.Fatal("another unit's ready armed a candidate before bind")
	}
	if ok, _ := p.settled(now.Add(3*time.Second), time.Second); ok {
		t.Fatal("settled on a named ready before the prompt's unit was known")
	}
	p.bindScoop("cone-1")
	if ok, _ := p.settled(now.Add(3*time.Second), time.Second); ok {
		t.Fatal("bind adopted the other unit's ready")
	}
	if !p.status("ready", "cone-1", now.Add(4*time.Second)) {
		t.Fatal("the bound unit's ready did not become a candidate")
	}
	if ok, _ := p.settled(now.Add(6*time.Second), time.Second); !ok {
		t.Fatal("the bound unit's ready did not settle")
	}
}

func TestPromptTurnLegacyUnnamedStatusStillSettles(t *testing.T) {
	p := &promptTurn{}
	now := time.Now()
	p.status("processing", "", now)
	if !p.status("ready", "", now) {
		t.Fatal("unnamed ready on a leader that names no units should arm")
	}
	if ok, _ := p.settled(now.Add(2*time.Second), time.Second); !ok {
		t.Fatal("legacy ready did not settle")
	}
}

func TestPromptTurnRosterGuessYieldsToTheAck(t *testing.T) {
	p := &promptTurn{}
	now := time.Now()
	p.bindConeGuess("cone-1")
	p.status("processing", "scoop-9", now)
	if p.status("ready", "scoop-9", now.Add(time.Second)) {
		t.Fatal("a scoop ready armed while the guess was the cone")
	}
	p.bindScoop("scoop-9")
	if ok, _ := p.settled(now.Add(3*time.Second), time.Second); ok {
		t.Fatal("the cone guess's clock survived the ack")
	}
	if !p.status("ready", "scoop-9", now.Add(4*time.Second)) {
		t.Fatal("the acked unit's ready did not arm")
	}
}

func TestSoleConeJid(t *testing.T) {
	jid, ok := soleConeJid([]byte(`{"type":"scoops.list","scoops":[{"jid":"cone-1","parentId":null},{"jid":"sports","parentId":"cone-1"}]}`))
	if !ok || jid != "cone-1" {
		t.Fatalf("sole cone = %q %v", jid, ok)
	}
	if _, ok := soleConeJid([]byte(`{"type":"scoops.list","scoops":[{"jid":"a","parentId":null},{"jid":"b","parentId":null}]}`)); ok {
		t.Fatal("two roots must not be a guess")
	}
	if _, ok := soleConeJid([]byte(`{"type":"scoops.list","scoops":[{"jid":"legacy"}]}`)); ok {
		t.Fatal("an absent parentId must not be invented as a cone")
	}
	jid, ok = soleConeJid([]byte(`{"type":"scoops.list","scoops":[{"jid":"cone-1","isCone":true}]}`))
	if !ok || jid != "cone-1" {
		t.Fatalf("isCone fallback = %q %v", jid, ok)
	}
}
