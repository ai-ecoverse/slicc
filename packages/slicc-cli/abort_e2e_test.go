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

func TestCLIAbortWaitsForLeaderAck(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)
	acked := make(chan time.Time, 1)
	leader.dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var env protocol.Envelope
		if json.Unmarshal(msg.Data, &env) != nil || env.Type != "abort" {
			return
		}
		go func() {
			time.Sleep(150 * time.Millisecond)
			acked <- time.Now()
			_ = sendJSON(leader.dc, protocol.AbortAck{
				Type: protocol.TypeAbortAck, ScoopJid: "cone", Stopped: []string{"cone", "scoop"},
			})
		}()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, leader.joinURL, "abort")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("abort exit: %v; stderr: %s", err, stderr.String())
	}
	select {
	case at := <-acked:
		if time.Now().Before(at) {
			t.Fatal("abort exited before the leader confirmed")
		}
	default:
		t.Fatal("leader never sent abort_ack")
	}
	if strings.TrimSpace(stdout.String()) != "stopped" {
		t.Fatalf("abort stdout = %q", stdout.String())
	}
}

func TestCLIAbortFailsWithoutLeaderAck(t *testing.T) {
	bin := sliccBinary(t)
	leader := newBridgedLeader(t)
	leader.dc.OnMessage(func(webrtc.DataChannelMessage) {})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, leader.joinURL, "abort")
	cmd.Env = append(os.Environ(), "SLICC_ABORT_CONFIRM=150ms")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil || cmd.ProcessState.ExitCode() != 1 {
		t.Fatalf("abort exit = %v, want 1", err)
	}
	if !strings.Contains(stderr.String(), "the leader did not confirm the turn stopped") {
		t.Fatalf("abort stderr = %q", stderr.String())
	}
}
