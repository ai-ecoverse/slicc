package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
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
	p.activity()
	if !p.status("ready", "cone-1", now.Add(4*time.Second)) {
		t.Fatal("the bound unit's ready did not become a candidate")
	}
	if ok, _ := p.settled(now.Add(6*time.Second), time.Second); !ok {
		t.Fatal("the bound unit's ready did not settle")
	}
}

func TestPromptTurnStartupReadyBeforeAnyAgentEventDoesNotSettle(t *testing.T) {
	p := &promptTurn{}
	now := time.Now()
	p.bindScoop("cone-1")
	p.status("processing", "cone-1", now)
	if p.status("ready", "cone-1", now.Add(10*time.Millisecond)) {
		t.Fatal("ready before any agent event armed a candidate")
	}
	if ok, _ := p.settled(now.Add(3*time.Second), time.Second); ok {
		t.Fatal("startup ready settled")
	}
	p.activity()
	if !p.status("ready", "cone-1", now.Add(4*time.Second)) {
		t.Fatal("ready after agent output did not arm")
	}
	if ok, _ := p.settled(now.Add(6*time.Second), time.Second); !ok {
		t.Fatal("ready after agent output did not settle")
	}
}

func TestPromptTurnLegacyUnnamedStatusStillSettles(t *testing.T) {
	p := &promptTurn{}
	now := time.Now()
	p.status("processing", "", now)
	p.activity()
	if !p.status("ready", "", now) {
		t.Fatal("unnamed ready after agent output should arm")
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
	p.activity()
	if !p.status("ready", "scoop-9", now.Add(4*time.Second)) {
		t.Fatal("the acked unit's ready did not arm")
	}
}

func TestPromptTurnBuffersOtherUnitUntilAck(t *testing.T) {
	var out bytes.Buffer
	p := &promptTurn{out: &out}
	now := time.Now()
	if _, done := p.ingestStatus(statusRaw("ready", "sports"), now); done {
		t.Fatal("another unit's ready ended the prompt before the ack")
	}
	if _, done := p.ingestAgent(agentRaw("sports", protocol.AgentToolUseStart, "LEAK")); done {
		t.Fatal("another unit's tool_use_start ended the prompt")
	}
	if _, done := p.ingestAgent(agentRaw("sports", protocol.AgentContentDelta, "LEAK")); done {
		t.Fatal("another unit's text ended the prompt")
	}
	p.ingestStatus(statusRaw("processing", "cone-1"), now)
	p.ingestAgent(agentRaw("cone-1", protocol.AgentContentDelta, "ONE"))
	p.ingestAgent(agentRaw("cone-1", protocol.AgentContentDelta, "TWO"))
	if out.Len() != 0 || p.pendingTools != 0 {
		t.Fatalf("before ack stdout=%q pending=%d; foreign frames were applied", out.String(), p.pendingTools)
	}
	if _, done := p.ingestAck("mine", ackRaw("mine", "cone-1")); done {
		t.Fatal("rebinding the cone ended the prompt")
	}
	if out.String() != "ONETWO" {
		t.Fatalf("replayed stdout = %q, want ONETWO in order and nothing from sports", out.String())
	}
	if p.pendingTools != 0 {
		t.Fatal("the other unit's tool_use_start is still pending")
	}
	if !p.status("ready", "cone-1", now.Add(time.Second)) {
		t.Fatal("cone ready after replayed output did not arm")
	}
}

func statusRaw(status, jid string) []byte {
	raw, err := json.Marshal(protocol.Status{Type: protocol.TypeStatus, ScoopStatus: status, ScoopJid: jid})
	if err != nil {
		panic(err)
	}
	return raw
}

func agentRaw(jid, eventType, text string) []byte {
	raw, err := json.Marshal(protocol.AgentEventEnvelope{
		Type: protocol.TypeAgentEvent, ScoopJid: jid,
		Event: protocol.AgentEvent{Type: eventType, MessageID: "m", Text: text, ToolName: text},
	})
	if err != nil {
		panic(err)
	}
	return raw
}

func ackRaw(messageID, jid string) []byte {
	raw, err := json.Marshal(protocol.UserMessageAck{
		Type: protocol.TypeUserMessageAck, MessageID: messageID, ScoopJid: jid, State: protocol.AckAccepted,
	})
	if err != nil {
		panic(err)
	}
	return raw
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
	if _, ok := soleConeJid([]byte(`{"type":"scoops.list","scoops":[{"jid":"cone-1","isCone":true}]}`)); ok {
		t.Fatal("isCone alone must not invent a cone after #2358 stage 3")
	}
}
