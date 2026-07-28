package optel

// Event is one RUM beacon ready to be POSTed to the collector. The JSON
// encoding is byte-compatible with helix-rum-js `sampleRUM.sendPing` and
// with swift-optel's RUMEvent:
//
//	{ "weight": 100, "id": "abc123def", "referer": "https://slicc-cli/",
//	  "checkpoint": "enter", "t": 0, "source": "prompt" }
//
// Source and Target are omitted from the wire payload when empty — go-optel
// never sends an explicit `null`, matching the other two implementations.
type Event struct {
	Weight     int        `json:"weight"`
	ID         string     `json:"id"`
	Referer    string     `json:"referer"`
	Checkpoint Checkpoint `json:"checkpoint"`
	T          int        `json:"t"`
	Source     string     `json:"source,omitempty"`
	Target     string     `json:"target,omitempty"`
}
