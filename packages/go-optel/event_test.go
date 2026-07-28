package optel

import (
	"encoding/json"
	"testing"
)

func TestEventEncodingOmitsEmptySourceAndTarget(t *testing.T) {
	event := Event{Weight: 100, ID: "abc123456", Referer: "https://slicc-cli/", Checkpoint: Enter, T: 0}
	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, key := range []string{"source", "target"} {
		if _, present := decoded[key]; present {
			t.Errorf("expected %q to be omitted, got %v", key, decoded[key])
		}
	}
	if decoded["checkpoint"] != "enter" {
		t.Errorf("checkpoint = %v, want %q", decoded["checkpoint"], "enter")
	}
}

func TestEventEncodingIncludesSourceAndTarget(t *testing.T) {
	event := Event{
		Weight: 100, ID: "abc123456", Referer: "https://slicc-cli/",
		Checkpoint: Error, T: 12, Source: "dial", Target: "connection refused",
	}
	b, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded["source"] != "dial" || decoded["target"] != "connection refused" {
		t.Errorf("unexpected source/target: %v/%v", decoded["source"], decoded["target"])
	}
}
