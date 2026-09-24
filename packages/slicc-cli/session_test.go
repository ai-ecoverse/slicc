package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)

func TestParseNewSessionArgs(t *testing.T) {
	if a := parseNewSessionArgs(nil); a.action != "save" || a.timeout != newSessionTimeout || a.err != "" {
		t.Fatalf("defaults = %+v", a)
	}
	if a := parseNewSessionArgs([]string{"--erase", "--timeout", "5s"}); a.action != "erase" || a.timeout != 5*time.Second {
		t.Fatalf("erase = %+v", a)
	}
	if a := parseNewSessionArgs([]string{"--skip"}); a.action != "skip" {
		t.Fatalf("skip = %+v", a)
	}
	if !parseNewSessionArgs([]string{"-h"}).help {
		t.Fatal("-h is help")
	}
	for _, bad := range [][]string{{"--timeout"}, {"--timeout", "soon"}, {"--timeout", "-1s"}, {"--wipe"}} {
		if parseNewSessionArgs(bad).err == "" {
			t.Errorf("%v should be an error", bad)
		}
	}
}

func TestParseModelArgs(t *testing.T) {
	a := parseModelArgs([]string{"--json", "--timeout", "3s", "claude-sonnet-5"})
	if !a.json || a.timeout != 3*time.Second || a.query != "claude-sonnet-5" || a.err != "" {
		t.Fatalf("parsed = %+v", a)
	}
	if a := parseModelArgs(nil); a.query != "" || a.timeout != modelTimeout {
		t.Fatalf("defaults = %+v", a)
	}
	if !parseModelArgs([]string{"--help"}).help {
		t.Fatal("--help is help")
	}
	for _, bad := range [][]string{{"a", "b"}, {"--fast"}, {"--timeout"}, {"--timeout", "0s"}} {
		if parseModelArgs(bad).err == "" {
			t.Errorf("%v should be an error", bad)
		}
	}
}

var catalog = []protocol.ModelCatalogEntry{
	{ProviderName: "AWS Bedrock", ModelID: "bedrock-camp:global.anthropic.claude-sonnet-5", ModelName: "Claude Sonnet 5 (Global)"},
	{ProviderName: "AWS Bedrock", ModelID: "bedrock-camp:us.anthropic.claude-sonnet-5", ModelName: "Claude Sonnet 5 (US)"},
	{ProviderName: "AWS Bedrock", ModelID: "bedrock-camp:us.anthropic.claude-opus-5-5", ModelName: "Claude Opus 5.5 (US)"},
	{ProviderName: "AWS Bedrock", ModelID: "bedrock-camp:global.openai.gpt-5.6-luna", ModelName: "GPT-5.6 Luna"},
	{ProviderName: "Anthropic", ModelID: "anthropic:claude-opus-5-5", ModelName: "Claude Opus 5.5"},
	{ProviderName: "OpenRouter", ModelID: "openrouter:x.gpt-5.6-luna", ModelName: "GPT-5.6 Luna"},
}

func TestResolveModel(t *testing.T) {
	cases := []struct{ query, want, err string }{
		{query: "bedrock-camp:us.anthropic.claude-sonnet-5", want: "bedrock-camp:us.anthropic.claude-sonnet-5"},
		{query: "us.anthropic.claude-sonnet-5", want: "bedrock-camp:us.anthropic.claude-sonnet-5"},
		{query: "claude-sonnet-5", want: "bedrock-camp:global.anthropic.claude-sonnet-5"},
		{query: "anthropic.claude-sonnet-5", want: "bedrock-camp:global.anthropic.claude-sonnet-5"},
		{query: "claude-opus-5-5", want: "anthropic:claude-opus-5-5"},
		{query: "gpt-5.6-luna", err: "ambiguous: bedrock-camp:global.openai.gpt-5.6-luna, openrouter:x.gpt-5.6-luna"},
		{query: "gemini-9", err: "no model matches"},
	}
	for _, c := range cases {
		got, err := resolveModel(c.query, catalog)
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%s: err = %v, want %q", c.query, err, c.err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s = %q, %v; want %q", c.query, got, err, c.want)
		}
	}
	dupes := []protocol.ModelCatalogEntry{{ModelID: "a:m"}, {ModelID: "b:m"}}
	if _, err := resolveModel("m", dupes); err == nil || !strings.Contains(err.Error(), "ambiguous: a:m, b:m") {
		t.Errorf("same model part in two providers: %v", err)
	}
	noGlobal := []protocol.ModelCatalogEntry{{ModelID: "p:us.x.m"}, {ModelID: "p:eu.x.m"}}
	if _, err := resolveModel("m", noGlobal); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Errorf("regional twins without a global profile: %v", err)
	}
	if got, err := resolveModel("m", []protocol.ModelCatalogEntry{{ModelID: "bare.m"}}); err != nil || got != "bare.m" {
		t.Errorf("unqualified id: %q, %v", got, err)
	}
}

func TestHasUserMessage(t *testing.T) {
	msgs := func(s ...string) []json.RawMessage {
		out := make([]json.RawMessage, len(s))
		for i, m := range s {
			out[i] = json.RawMessage(m)
		}
		return out
	}
	if hasUserMessage(msgs(`{"role":"assistant","content":"hi"}`, `not json`)) {
		t.Error("no user turn")
	}
	if !hasUserMessage(msgs(`{"role":"assistant"}`, `{"role":"user","content":"x"}`)) {
		t.Error("user turn present")
	}
}



type controlLeader struct {
	*bridgedLeader
	mu   sync.Mutex
	seen []map[string]any
}

func newControlLeader(t *testing.T, reply func(typ string, msg map[string]any) []any) *controlLeader {
	t.Helper()
	l := &controlLeader{bridgedLeader: newBridgedLeader(t)}
	l.dc.OnMessage(func(m webrtc.DataChannelMessage) {
		var msg map[string]any
		if json.Unmarshal(m.Data, &msg) != nil {
			return
		}
		typ, _ := msg["type"].(string)
		l.mu.Lock()
		l.seen = append(l.seen, msg)
		l.mu.Unlock()
		for _, f := range reply(typ, msg) {
			_ = sendJSON(l.dc, f)
		}
	})
	return l
}

func (l *controlLeader) received(typ string) []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	for _, m := range l.seen {
		if m["type"] == typ {
			out = append(out, m)
		}
	}
	return out
}

func runCLI(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, sliccBinary(t), args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		t.Fatalf("run slicc: %v", err)
	}
	return stdout.String(), stderr.String(), code
}

func snapshotFrame(messages ...string) protocol.Snapshot {
	raw := make([]json.RawMessage, len(messages))
	for i, m := range messages {
		raw[i] = json.RawMessage(m)
	}
	return protocol.Snapshot{Type: protocol.TypeSnapshot, Messages: raw, ScoopJid: "cone_1"}
}

func TestCLINewSessionWaitsForAnEmptyConversation(t *testing.T) {
	var mu sync.Mutex
	reset := false
	leader := newControlLeader(t, func(typ string, _ map[string]any) []any {
		mu.Lock()
		defer mu.Unlock()
		switch typ {
		case protocol.TypeNewSession:
			reset = true
		case protocol.TypeRequestSnapshot:
			if reset {
				return []any{snapshotFrame()}
			}
			return []any{snapshotFrame(`{"id":"m1","role":"user","content":"old task"}`)}
		}
		return nil
	})
	stdout, stderr, code := runCLI(t, leader.joinURL, "new-session", "--erase")
	if code != 0 {
		t.Fatalf("exit %d; stderr:\n%s", code, stderr)
	}
	if strings.TrimSpace(stdout) != "new session (erase)" {
		t.Fatalf("stdout = %q", stdout)
	}
	sent := leader.received(protocol.TypeNewSession)
	if len(sent) != 1 || sent[0]["action"] != "erase" {
		t.Fatalf("new_session frames = %v", sent)
	}
}

func TestCLINewSessionFailsWhenTheOldConversationStays(t *testing.T) {
	leader := newControlLeader(t, func(typ string, _ map[string]any) []any {
		if typ == protocol.TypeRequestSnapshot {
			return []any{snapshotFrame(`{"id":"m1","role":"user","content":"still here"}`)}
		}
		return nil
	})
	_, stderr, code := runCLI(t, leader.joinURL, "new-session", "--timeout", "2500ms")
	if code != 1 || !strings.Contains(stderr, "still held user messages after 2.5s") {
		t.Fatalf("exit %d; stderr:\n%s", code, stderr)
	}
	if sent := leader.received(protocol.TypeNewSession); len(sent) != 1 || sent[0]["action"] != "save" {
		t.Fatalf("default action: %v", sent)
	}
}

func modelFrames(active string) []any {
	return []any{
		protocol.ModelsList{Type: protocol.TypeModelsList, Models: catalog},
		protocol.ModelState{Type: protocol.TypeModelState, State: protocol.ModelSelectionState{ActiveModelID: active, ScoopJid: "cone_1"}},
	}
}

func TestCLIModelListsTheCatalogue(t *testing.T) {
	leader := newControlLeader(t, func(typ string, _ map[string]any) []any {
		if typ == protocol.TypeModelsRequest {
			return modelFrames("bedrock-camp:us.anthropic.claude-opus-5-5")
		}
		return nil
	})
	stdout, stderr, code := runCLI(t, leader.joinURL, "model")
	if code != 0 {
		t.Fatalf("exit %d; stderr:\n%s", code, stderr)
	}
	if !strings.Contains(stdout, "* bedrock-camp:us.anthropic.claude-opus-5-5\tClaude Opus 5.5 (US)") ||
		!strings.Contains(stdout, "  bedrock-camp:global.anthropic.claude-sonnet-5\t") {
		t.Fatalf("stdout:\n%s", stdout)
	}
	
	second := newControlLeader(t, func(typ string, _ map[string]any) []any {
		if typ == protocol.TypeModelsRequest {
			return modelFrames("bedrock-camp:us.anthropic.claude-opus-5-5")
		}
		return nil
	})
	stdout, _, code = runCLI(t, second.joinURL, "model", "--json")
	var listing modelListing
	if code != 0 || json.Unmarshal([]byte(stdout), &listing) != nil || listing.Active != "bedrock-camp:us.anthropic.claude-opus-5-5" || listing.ScoopJid != "cone_1" || len(listing.Models) != len(catalog) {
		t.Fatalf("json listing (exit %d): %s", code, stdout)
	}
}

func TestCLIModelSwitchesTheConeAndWaitsForTheLeader(t *testing.T) {
	var mu sync.Mutex
	active := "bedrock-camp:us.anthropic.claude-opus-5-5"
	leader := newControlLeader(t, func(typ string, msg map[string]any) []any {
		mu.Lock()
		defer mu.Unlock()
		switch typ {
		case protocol.TypeModelsRequest:
			return modelFrames(active)
		case protocol.TypeModelSelect:
			active, _ = msg["modelId"].(string)
			return []any{protocol.ModelState{Type: protocol.TypeModelState, State: protocol.ModelSelectionState{ActiveModelID: active, ScoopJid: "cone_1"}}}
		}
		return nil
	})
	stdout, stderr, code := runCLI(t, leader.joinURL, "model", "claude-sonnet-5")
	if code != 0 || strings.TrimSpace(stdout) != "bedrock-camp:global.anthropic.claude-sonnet-5" {
		t.Fatalf("exit %d stdout %q stderr:\n%s", code, stdout, stderr)
	}
	sel := leader.received(protocol.TypeModelSelect)
	if len(sel) != 1 || sel[0]["modelId"] != "bedrock-camp:global.anthropic.claude-sonnet-5" || sel[0]["scoopJid"] != "cone_1" {
		t.Fatalf("model.select frames = %v", sel)
	}
	already := newControlLeader(t, func(typ string, _ map[string]any) []any {
		if typ == protocol.TypeModelsRequest {
			return modelFrames("bedrock-camp:global.anthropic.claude-sonnet-5")
		}
		return nil
	})
	stdout, _, code = runCLI(t, already.joinURL, "model", "claude-sonnet-5")
	if code != 0 || strings.TrimSpace(stdout) != "bedrock-camp:global.anthropic.claude-sonnet-5" || len(already.received(protocol.TypeModelSelect)) != 0 {
		t.Fatalf("an already-active model must not be re-selected (exit %d, %q)", code, stdout)
	}
}

func TestCLIModelReportsARejectedSwitch(t *testing.T) {
	refusing := func(typ string, _ map[string]any) []any {
		switch typ {
		case protocol.TypeModelsRequest:
			return modelFrames("bedrock-camp:us.anthropic.claude-opus-5-5")
		case protocol.TypeModelSelect:
			
			return []any{
				protocol.ModelState{Type: protocol.TypeModelState, State: protocol.ModelSelectionState{ActiveModelID: "x", ScoopJid: "other_cone"}},
				protocol.ModelState{Type: protocol.TypeModelState, State: protocol.ModelSelectionState{ActiveModelID: "bedrock-camp:us.anthropic.claude-opus-5-5", ScoopJid: "cone_1"}},
			}
		}
		return nil
	}
	_, stderr, code := runCLI(t, newControlLeader(t, refusing).joinURL, "model", "--timeout", "2s", "gpt-5.6-luna")
	if code != 1 || !strings.Contains(stderr, "ambiguous") {
		t.Fatalf("ambiguous query: exit %d stderr %s", code, stderr)
	}
	_, stderr, code = runCLI(t, newControlLeader(t, refusing).joinURL, "model", "--timeout", "2s", "bedrock-camp:global.openai.gpt-5.6-luna")
	if code != 1 || !strings.Contains(stderr, "did not switch to bedrock-camp:global.openai.gpt-5.6-luna within 2s (still bedrock-camp:us.anthropic.claude-opus-5-5)") {
		t.Fatalf("rejected switch: exit %d stderr %s", code, stderr)
	}
}

func TestCLIModelTimesOutWithoutACatalogue(t *testing.T) {
	leader := newControlLeader(t, func(string, map[string]any) []any { return nil })
	_, stderr, code := runCLI(t, leader.joinURL, "model", "--timeout", "1s")
	if code != 1 || !strings.Contains(stderr, "no model list within 1s") {
		t.Fatalf("exit %d stderr %s", code, stderr)
	}
}

func TestCLIControlVerbsRejectBadArguments(t *testing.T) {
	
	leader := newControlLeader(t, func(string, map[string]any) []any { return nil })
	if _, stderr, code := runCLI(t, leader.joinURL, "new-session", "--wipe"); code != 2 || !strings.Contains(stderr, `unexpected argument "--wipe"`) {
		t.Fatalf("new-session: exit %d %s", code, stderr)
	}
	if _, stderr, code := runCLI(t, leader.joinURL, "model", "a", "b"); code != 2 || !strings.Contains(stderr, `unexpected argument "b"`) {
		t.Fatalf("model: exit %d %s", code, stderr)
	}
	if stdout, _, code := runCLI(t, leader.joinURL, "model", "--help"); code != 0 || !strings.Contains(stdout, "new-session [--save|--skip|--erase]") {
		t.Fatalf("model --help: exit %d", code)
	}
	if stdout, _, code := runCLI(t, leader.joinURL, "new-session", "-h"); code != 0 || !strings.Contains(stdout, "model [--json]") {
		t.Fatalf("new-session -h: exit %d", code)
	}
}
