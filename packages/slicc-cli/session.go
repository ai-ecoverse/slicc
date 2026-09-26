package main








import (
	"context"
	"encoding/json"
	"errors"
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
	conn, err := dialAndSend(
		func() (*tray.Conn, error) {
			return tray.Dial(ctx, joinURL, tray.Options{OnMessage: handler, Logf: debugLogf, LogWanted: diagLogger.EnabledAt})
		},
		func(conn *tray.Conn) error {
			
			
			select {
			case <-fresh:
			default:
			}
			return conn.SendJSON(protocol.NewSession{Type: protocol.TypeNewSession, Action: a.action})
		},
	)
	if err != nil {
		errLine("new-session", "%s", err)
		var dialErr *dialFailed
		if errors.As(err, &dialErr) {
			reportRuntimeError("dial", err)
		}
		return 1
	}
	defer conn.Close()
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


var regionPrefixes = []string{"global.", "us.", "eu.", "apac.", "jp.", "au.", "us-gov."}

func withoutRegion(model string) string {
	for _, p := range regionPrefixes {
		if strings.HasPrefix(model, p) {
			return strings.TrimPrefix(model, p)
		}
	}
	return model
}










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


type modelListing struct {
	Active   string                       `json:"active"`
	ScoopJid string                       `json:"scoopJid"`
	Models   []protocol.ModelCatalogEntry `json:"models"`
}



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



func cmdModel(ctx context.Context, joinURL string, a modelArgs) int {
	ch := newModelChannels()
	conn, err := dialAndSend(
		func() (*tray.Conn, error) {
			return tray.Dial(ctx, joinURL, tray.Options{OnMessage: ch.handle, Logf: debugLogf, LogWanted: diagLogger.EnabledAt})
		},
		func(conn *tray.Conn) error {
			return conn.SendJSON(protocol.ModelsRequest{Type: protocol.TypeModelsRequest})
		},
	)
	if err != nil {
		errLine("model", "%s", err)
		var dialErr *dialFailed
		if errors.As(err, &dialErr) {
			reportRuntimeError("dial", err)
		}
		return 1
	}
	defer conn.Close()

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
