package optel










type Event struct {
	Weight     int        `json:"weight"`
	ID         string     `json:"id"`
	Referer    string     `json:"referer"`
	Checkpoint Checkpoint `json:"checkpoint"`
	T          int        `json:"t"`
	Source     string     `json:"source,omitempty"`
	Target     string     `json:"target,omitempty"`
}
