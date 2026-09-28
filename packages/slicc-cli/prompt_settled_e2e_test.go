package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/pion/webrtc/v4"
)

func runPromptArgs(t *testing.T, bin, joinURL string, args ...string) (string, string, time.Duration, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	argv := append([]string{joinURL, "prompt"}, args...)
	argv = append(argv, "hi there")
	cmd := exec.CommandContext(ctx, bin, argv...)
	cmd.Env = append(os.Environ(), "SLICC_PROMPT_SETTLE=200ms")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	start := time.Now()
	err := cmd.Run()
	return stdout.String(), stderr.String(), time.Since(start), err
}

func coneAck(id string) protocol.UserMessageAck {
	ack := ackFrame(id, protocol.AckAccepted, "")
	ack.ScoopJid = "cone-1"
	return ack
}

func rosterFrame(jids ...string) map[string]any {
	return rosterWithState("", jids...)
}

func rosterWithState(state string, jids ...string) map[string]any {
	scoops := []map[string]any{}
	for _, jid := range jids {
		entry := map[string]any{"jid": jid, "parentId": "cone-1"}
		if state != "" && jid != "cone-1" {
			entry["state"] = state
		}
		if jid == "cone-1" {
			entry["parentId"] = nil
		}
		scoops = append(scoops, entry)
	}
	return map[string]any{"type": "scoops.list", "scoops": scoops}
}

// The cone hands work to a scoop and ends its turn; when the scoop reports
// back, the cone resumes and writes the real answer. That second turn is the
// one a benchmark must score.
func delegatingCone() []any {
	return []any{
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DISPATCHED"),
		statusFrameFor("scout", "processing"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
		700 * time.Millisecond,
		agentFrameFor("scout", protocol.AgentContentDelta, "s1", "scout notes"),
		statusFrameFor("scout", "ready"),
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m2", "FINAL ANSWER: 42"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m2", ""),
		statusFrameFor("cone-1", "ready"),
	}
}

// Without --allsettled the prompt ends at the first turn_end and misses the
// answer: this is what the benchmark recorded as "agent still working".
func TestCLIPromptWithoutAllSettledStopsAtFirstTurn(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, delegatingCone())
	stdout, stderr, _, err := runPromptArgs(t, bin, leader.joinURL)
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if strings.Contains(stdout, "FINAL ANSWER") {
		t.Fatalf("stdout = %q; expected the plain prompt to stop at the first turn_end", stdout)
	}
}

func TestCLIPromptAllSettledWaitsForScoopsAndResumedCone(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, delegatingCone())
	stdout, stderr, _, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "300ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "DISPATCHED\n\nFINAL ANSWER: 42") {
		t.Fatalf("stdout = %q, want both cone turns separated by a blank line", stdout)
	}
	if strings.Contains(stdout, "scout notes") {
		t.Fatalf("stdout = %q leaked the scoop's text", stdout)
	}
}

// Quiet means quiet: after the last frame the prompt still waits the period.
func TestCLIPromptAllSettledWaitsTheQuietPeriod(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, []any{
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DONE"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
	})
	stdout, stderr, took, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled=1500ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "DONE") {
		t.Fatalf("stdout = %q, want the reply", stdout)
	}
	if took < 1500*time.Millisecond {
		t.Fatalf("prompt exited after %s, before the 1.5s quiet period", took)
	}
}

// A scoop removed from the roster never sends its own ready; it must not
// hold the prompt open.
func TestCLIPromptAllSettledForgetsDroppedScoops(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, []any{
		statusFrameFor("cone-1", "processing"),
		statusFrameFor("scout", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DONE"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
		rosterFrame("cone-1"),
	})
	stdout, stderr, _, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "300ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "DONE") {
		t.Fatalf("stdout = %q, want the reply", stdout)
	}
}

// A scoop still processing keeps the prompt open past the quiet period; the
// bench's own timeout (SIGINT) is what ends a run that never settles.
func TestCLIPromptAllSettledHoldsWhileAScoopIsBusy(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, []any{
		statusFrameFor("cone-1", "processing"),
		statusFrameFor("scout", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DONE"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
		1200 * time.Millisecond,
		statusFrameFor("scout", "ready"),
	})
	_, stderr, took, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "300ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if took < 1500*time.Millisecond {
		t.Fatalf("prompt exited after %s, while the scoop was still processing", took)
	}
}

// A leader can report ready after the assistant message containing a tool call,
// while the tool is still running. The tool result, not that ready, ends the work.
func TestCLIPromptAllSettledHoldsPendingForeignTool(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, []any{
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DISPATCHED"),
		agentFrameFor("scout", protocol.AgentToolUseStart, "s1", ""),
		statusFrameFor("scout", "ready"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
		1200 * time.Millisecond,
		agentFrameFor("scout", protocol.AgentToolResult, "s1", ""),
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m2", "FINAL ANSWER: recovered"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m2", ""),
		statusFrameFor("cone-1", "ready"),
	})
	stdout, stderr, took, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "300ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if took < 1200*time.Millisecond || !strings.Contains(stdout, "FINAL ANSWER: recovered") {
		t.Fatalf("prompt exited after %s with %q, before the pending scoop tool finished", took, stdout)
	}
}

func TestCLIWaitAllSettledObservesPendingToolWithoutSendingPrompt(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)
	leader.dc.OnOpen(func() {
		go func() {
			_ = sendJSON(leader.dc, rosterWithState("idle", "cone-1", "scout"))
			_ = sendJSON(leader.dc, agentFrameFor("scout", protocol.AgentToolUseStart, "s1", ""))
			_ = sendJSON(leader.dc, statusFrameFor("scout", "ready"))
			time.Sleep(1200 * time.Millisecond)
			_ = sendJSON(leader.dc, agentFrameFor("scout", protocol.AgentToolResult, "s1", ""))
		}()
	})
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var frame struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg.Data, &frame)
		if frame.Type == "user_message" {
			t.Error("wait sent a prompt")
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, leader.joinURL, "wait", "--allsettled", "300ms")
	start := time.Now()
	out, err := cmd.CombinedOutput()
	if err != nil || time.Since(start) < 1200*time.Millisecond {
		t.Fatalf("wait exited after %s: %v (%s)", time.Since(start), err, out)
	}
}

// A scoop already working when the prompt connects shows up only in the
// roster snapshot; it must hold the prompt open like a processing status.
func TestCLIPromptAllSettledCountsWorkingScoopsFromTheRoster(t *testing.T) {
	bin := sliccBinary(t)
	leader := ackLeader(t, coneAck, []any{
		rosterWithState("working", "cone-1", "scout"),
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DONE"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
		1200 * time.Millisecond,
		rosterWithState("idle", "cone-1", "scout"),
	})
	_, stderr, took, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "300ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if took < 1500*time.Millisecond {
		t.Fatalf("prompt exited after %s, while the roster still showed the scoop working", took)
	}
}

// A live leader re-broadcasts `scoops.list` every 5 s. Those snapshots are
// state, not activity: counting them as frames kept every bench prompt open
// until its 60-minute timeout (stage 2 run 36359378966).
func TestCLIPromptAllSettledIgnoresRosterHeartbeats(t *testing.T) {
	bin := sliccBinary(t)
	frames := []any{
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DONE"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
	}
	for i := 0; i < 40; i++ {
		frames = append(frames, 100*time.Millisecond, rosterWithState("idle", "cone-1", "scout"))
	}
	leader := ackLeader(t, coneAck, frames)
	stdout, stderr, took, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "500ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "DONE") {
		t.Fatalf("stdout = %q, want the reply", stdout)
	}
	if took > 3*time.Second {
		t.Fatalf("prompt took %s: idle roster heartbeats (4 s of them) held the 500ms quiet period open", took)
	}
}

// A scoop known busy only from the roster, and later reported idle only by a
// roster snapshot, finishes at that snapshot: the quiet period starts there,
// not when the scoop first turned busy.
func TestCLIPromptAllSettledQuietStartsWhenARosterScoopGoesIdle(t *testing.T) {
	bin := sliccBinary(t)
	frames := []any{
		rosterWithState("working", "cone-1", "scout"),
		statusFrameFor("cone-1", "processing"),
		agentFrameFor("cone-1", protocol.AgentContentDelta, "m1", "DONE"),
		agentFrameFor("cone-1", protocol.AgentTurnEnd, "m1", ""),
		statusFrameFor("cone-1", "ready"),
	}
	for i := 0; i < 30; i++ {
		frames = append(frames, 100*time.Millisecond, rosterWithState("working", "cone-1", "scout"))
	}
	frames = append(frames, rosterWithState("idle", "cone-1", "scout"))
	leader := ackLeader(t, coneAck, frames)
	_, stderr, took, err := runPromptArgs(t, bin, leader.joinURL, "--allsettled", "2500ms")
	if err != nil {
		t.Fatalf("prompt CLI did not exit cleanly: %v; stderr:\n%s", err, stderr)
	}
	// 3 s of working heartbeats, then 2.5 s of quiet after the idle snapshot.
	// Without that quiet the prompt exits right at the snapshot, about 3 s in.
	if took < 5500*time.Millisecond {
		t.Fatalf("prompt exited after %s, without a quiet period after the scoop went idle", took)
	}
}

func TestParsePromptArgs(t *testing.T) {
	cases := []struct {
		args    []string
		quiet   time.Duration
		rest    []string
		wantErr bool
	}{
		{[]string{"hello"}, 0, []string{"hello"}, false},
		{[]string{"--allsettled", "2m", "-"}, 2 * time.Minute, []string{"-"}, false},
		{[]string{"--allsettled=90s", "do", "it"}, 90 * time.Second, []string{"do", "it"}, false},
		{[]string{"say", "--allsettled", "2m"}, 0, []string{"say", "--allsettled", "2m"}, false},
		{[]string{"--allsettled"}, 0, nil, true},
		{[]string{"--allsettled", "soon", "x"}, 0, nil, true},
		{[]string{"--allsettled=0s", "x"}, 0, nil, true},
	}
	for _, c := range cases {
		quiet, rest, errMsg := parsePromptArgs(c.args)
		if (errMsg != "") != c.wantErr {
			t.Fatalf("%q: err = %q, wantErr %v", c.args, errMsg, c.wantErr)
		}
		if c.wantErr {
			continue
		}
		got, _ := json.Marshal(rest)
		want, _ := json.Marshal(c.rest)
		if quiet != c.quiet || string(got) != string(want) {
			t.Fatalf("%q: got (%s, %s), want (%s, %s)", c.args, quiet, got, c.quiet, want)
		}
	}
}
