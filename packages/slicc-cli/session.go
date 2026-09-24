package main

// Leader-control verbs a harness needs to drive the cone from outside, as the
// browser and iOS followers already can: start a fresh conversation
// (`new-session`, the "New chat" button) and read or pick the cone's model
// (`model`, the model picker). Both ride tray-sync messages the leader already
// handles for followers (new_session, models.request, model.select), so the
// cone does the work exactly as it would for a person.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

const (
	newSessionTimeout = 30 * time.Second
	modelTimeout      = 20 * time.Second
	snapshotPoll      = time.Second
)

// newSessionArgs is `new-session [--save|--skip|--erase] [--timeout <dur>]`.
type newSessionArgs struct {
	action  string
	timeout time.Duration
	help    bool
	err     string
}

func parseNewSessionArgs(args []string) newSessionArgs {
	a := newSessionArgs{action: "save", timeout: newSessionTimeout}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			a.help = true
		case "--save", "--skip", "--erase":
			a.action = strings.TrimPrefix(args[i], "--")
		case "--timeout":
			if i+1 >= len(args) {
				a.err = "--timeout needs a duration (e.g. 30s)"
				return a
			}
			d, err := time.ParseDuration(args[i+1])
			if err != nil || d <= 0 {
				a.err = fmt.Sprintf("--timeout %q is not a positive duration", args[i+1])
				return a
			}
			a.timeout = d
			i++
		default:
			a.err = fmt.Sprintf("unexpected argument %q", args[i])
			return a
		}
	}
	return a
}

// hasUserMessage reports whether a snapshot still holds a user turn, i.e. the
// conversation the new session replaces is still the one on screen.
func hasUserMessage(messages []json.RawMessage) bool {
	for _, m := range messages {
		var role struct {
			Role string `json:"role"`
		}
		if json.Unmarshal(m, &role) == nil && role.Role == "user" {
			return true
		}
	}
	return false
}

// cmdNewSession asks the leader for a fresh conversation on the cone this
// follower views, then polls the transcript until it holds no user turn.
func cmdNewSession(ctx context.Context, joinURL string, a newSessionArgs) int {
	fresh := make(chan struct{}, 1)
	handler := func(typ string, raw []byte) {
		if typ != protocol.TypeSnapshot {
			return
		}
		var snap protocol.Snapshot
		if json.Unmarshal(raw, &snap) != nil || hasUserMessage(snap.Messages) {
			return
		}
		select {
		case fresh <- struct{}{}:
		default:
		}
	}
	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf, LogWanted: diagLogger.EnabledAt})
	if err != nil {
		errLine("new-session", "%s", err)
		reportRuntimeError("dial", err)
		return 1
	}
	defer conn.Close()

	// Drop any snapshot the connection handshake delivered: only one requested
	// after new_session says the old conversation is gone.
	select {
	case <-fresh:
	default:
	}
	if err := conn.SendJSON(protocol.NewSession{Type: protocol.TypeNewSession, Action: a.action}); err != nil {
		errLine("new-session", "%s", err)
		return 1
	}
	deadline := time.NewTimer(a.timeout)
	defer deadline.Stop()
	poll := time.NewTicker(snapshotPoll)
	defer poll.Stop()
	for {
		select {
		case <-fresh:
			fmt.Printf("new session (%s)\n", a.action)
			return 0
		case <-poll.C:
			if err := conn.SendJSON(protocol.RequestSnapshot{Type: protocol.TypeRequestSnapshot}); err != nil {
				errLine("new-session", "%s", err)
				return 1
			}
		case <-deadline.C:
			errLine("new-session", "the conversation still held user messages after %s", a.timeout)
			return 1
		case <-conn.Done():
			errLine("new-session", "connection closed")
			return 1
		case <-ctx.Done():
			return 130
		}
	}
}

// modelArgs is `model [--json] [--timeout <dur>] [<model>]`.
type modelArgs struct {
	query   string
	json    bool
	timeout time.Duration
	help    bool
	err     string
}

func parseModelArgs(args []string) modelArgs {
	a := modelArgs{timeout: modelTimeout}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-h", "--help":
			a.help = true
		case "--json":
			a.json = true
		case "--timeout":
			if i+1 >= len(args) {
				a.err = "--timeout needs a duration (e.g. 20s)"
				return a
			}
			d, err := time.ParseDuration(args[i+1])
			if err != nil || d <= 0 {
				a.err = fmt.Sprintf("--timeout %q is not a positive duration", args[i+1])
				return a
			}
			a.timeout = d
			i++
		default:
			if strings.HasPrefix(args[i], "-") || a.query != "" {
				a.err = fmt.Sprintf("unexpected argument %q", args[i])
				return a
			}
			a.query = args[i]
		}
	}
	return a
}

// regionPrefixes are Bedrock inference-profile scopes that name the same model.
var regionPrefixes = []string{"global.", "us.", "eu.", "apac.", "jp.", "au.", "us-gov."}

func withoutRegion(model string) string {
	for _, p := range regionPrefixes {
		if strings.HasPrefix(model, p) {
			return strings.TrimPrefix(model, p)
		}
	}
	return model
}

// resolveModel maps what a person types to the exact catalogue id the leader
// applies, most specific first:
//  1. the exact catalogue id ("bedrock-camp:global.anthropic.claude-sonnet-5");
//  2. the model part after "provider:" ("global.anthropic.claude-sonnet-5");
//  3. a suffix after a dot ("claude-sonnet-5"). When those matches differ only
//     by Bedrock region prefix (global., us., eu., …) the global profile is
//     taken, since it is the one that routes anywhere.
//
// Any other ambiguity is an error naming the candidates.
func resolveModel(query string, catalog []protocol.ModelCatalogEntry) (string, error) {
	var byModel, bySuffix []string
	for _, m := range catalog {
		if m.ModelID == query {
			return m.ModelID, nil
		}
		model := afterProvider(m.ModelID)
		if model == query {
			byModel = append(byModel, m.ModelID)
		} else if strings.HasSuffix(model, "."+query) {
			bySuffix = append(bySuffix, m.ModelID)
		}
	}
	if len(byModel) == 1 {
		return byModel[0], nil
	}
	if len(byModel) > 1 {
		sort.Strings(byModel)
		return "", fmt.Errorf("%q is ambiguous: %s", query, strings.Join(byModel, ", "))
	}
	sort.Strings(bySuffix)
	switch len(bySuffix) {
	case 0:
		return "", fmt.Errorf("no model matches %q (run `slicc <join-url> model` for the list)", query)
	case 1:
		return bySuffix[0], nil
	}
	base := withoutRegion(afterProvider(bySuffix[0]))
	provider := providerOf(bySuffix[0])
	for _, m := range bySuffix[1:] {
		if withoutRegion(afterProvider(m)) != base || providerOf(m) != provider {
			return "", fmt.Errorf("%q is ambiguous: %s", query, strings.Join(bySuffix, ", "))
		}
	}
	for _, m := range bySuffix {
		if strings.HasPrefix(afterProvider(m), "global.") {
			return m, nil
		}
	}
	return "", fmt.Errorf("%q is ambiguous: %s", query, strings.Join(bySuffix, ", "))
}

func providerOf(id string) string {
	if i := strings.Index(id, ":"); i >= 0 {
		return id[:i]
	}
	return ""
}

func afterProvider(id string) string {
	if i := strings.Index(id, ":"); i >= 0 {
		return id[i+1:]
	}
	return id
}

// modelListing is what `model --json` prints.
type modelListing struct {
	Active   string                       `json:"active"`
	ScoopJid string                       `json:"scoopJid"`
	Models   []protocol.ModelCatalogEntry `json:"models"`
}

// modelChannels routes models.list and model.state messages to channels;
// full channels drop, since only the latest answers matter.
type modelChannels struct {
	lists  chan []protocol.ModelCatalogEntry
	states chan protocol.ModelSelectionState
}

func newModelChannels() modelChannels {
	return modelChannels{
		lists:  make(chan []protocol.ModelCatalogEntry, 4),
		states: make(chan protocol.ModelSelectionState, 16),
	}
}

func (c modelChannels) handle(typ string, raw []byte) {
	switch typ {
	case protocol.TypeModelsList:
		var l protocol.ModelsList
		if json.Unmarshal(raw, &l) == nil {
			select {
			case c.lists <- l.Models:
			default:
			}
		}
	case protocol.TypeModelState:
		var s protocol.ModelState
		if json.Unmarshal(raw, &s) == nil {
			select {
			case c.states <- s.State:
			default:
			}
		}
	}
}

// cmdModel prints the cone's model and the catalogue, or selects a model and
// waits for the leader's model.state to confirm it.
func cmdModel(ctx context.Context, joinURL string, a modelArgs) int {
	ch := newModelChannels()
	conn, err := tray.Dial(ctx, joinURL, tray.Options{OnMessage: ch.handle, Logf: debugLogf, LogWanted: diagLogger.EnabledAt})
	if err != nil {
		errLine("model", "%s", err)
		reportRuntimeError("dial", err)
		return 1
	}
	defer conn.Close()
	if err := conn.SendJSON(protocol.ModelsRequest{Type: protocol.TypeModelsRequest}); err != nil {
		errLine("model", "%s", err)
		return 1
	}

	deadline := time.NewTimer(a.timeout)
	defer deadline.Stop()
	catalog, state, code := awaitCatalog(ctx, conn, ch, deadline.C, a.timeout)
	if code >= 0 {
		return code
	}
	if a.query == "" {
		printModels(a.json, state, catalog)
		return 0
	}
	want, err := resolveModel(a.query, catalog)
	if err != nil {
		errLine("model", "%s", err)
		return 1
	}
	if state.ActiveModelID == want {
		fmt.Println(want)
		return 0
	}
	if err := conn.SendJSON(protocol.ModelSelect{Type: protocol.TypeModelSelect, ModelID: want, ScoopJid: state.ScoopJid}); err != nil {
		errLine("model", "%s", err)
		return 1
	}
	return awaitSwitch(ctx, conn, ch, deadline.C, a.timeout, want, state)
}

// awaitCatalog waits for both the catalogue and the cone's model state. A
// non-negative code means the command is over with that exit status.
func awaitCatalog(ctx context.Context, conn *tray.Conn, ch modelChannels, deadline <-chan time.Time, timeout time.Duration) ([]protocol.ModelCatalogEntry, protocol.ModelSelectionState, int) {
	var catalog []protocol.ModelCatalogEntry
	var state *protocol.ModelSelectionState
	for catalog == nil || state == nil {
		select {
		case l := <-ch.lists:
			catalog = l
		case s := <-ch.states:
			state = &s
		case <-deadline:
			errLine("model", "the leader sent no model list within %s", timeout)
			return nil, protocol.ModelSelectionState{}, 1
		case <-conn.Done():
			errLine("model", "connection closed")
			return nil, protocol.ModelSelectionState{}, 1
		case <-ctx.Done():
			return nil, protocol.ModelSelectionState{}, 130
		}
	}
	return catalog, *state, -1
}

// awaitSwitch waits for a model.state for the cone's scoop naming want.
func awaitSwitch(ctx context.Context, conn *tray.Conn, ch modelChannels, deadline <-chan time.Time, timeout time.Duration, want string, before protocol.ModelSelectionState) int {
	last := before.ActiveModelID
	for {
		select {
		case s := <-ch.states:
			if s.ScoopJid != "" && before.ScoopJid != "" && s.ScoopJid != before.ScoopJid {
				continue
			}
			last = s.ActiveModelID
			if s.ActiveModelID == want {
				fmt.Println(want)
				return 0
			}
		case <-deadline:
			errLine("model", "the leader did not switch to %s within %s (still %s)", want, timeout, last)
			return 1
		case <-conn.Done():
			errLine("model", "connection closed")
			return 1
		case <-ctx.Done():
			return 130
		}
	}
}

func printModels(asJSON bool, state protocol.ModelSelectionState, catalog []protocol.ModelCatalogEntry) {
	if asJSON {
		out, _ := json.MarshalIndent(modelListing{Active: state.ActiveModelID, ScoopJid: state.ScoopJid, Models: catalog}, "", "  ")
		fmt.Println(string(out))
		return
	}
	for _, m := range catalog {
		mark := "  "
		if m.ModelID == state.ActiveModelID {
			mark = "* "
		}
		fmt.Fprintf(os.Stdout, "%s%s\t%s\n", mark, m.ModelID, m.ModelName)
	}
}
