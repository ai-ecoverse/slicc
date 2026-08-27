package signaling

import (
	"net/http"
	"testing"
)

// Pinned cross-implementation `successor-version` link vectors (#1957).
//
// The same table is pinned in:
//
//	packages/shared-ts/tests/successor-version-link.test.ts
//	packages/swift-trayfollower/Tests/SliccTrayFollowerTests/SupersedeLinkTests.swift
//	packages/swift-traysession/Tests/SliccTraySessionTests/SupersedeLinkTests.swift
//
// Four followers parse this header, and a disagreement between them is exactly
// the class of bug #1956 was: one implementation reads a redirect everyone else
// follows, dead-ends, and nobody notices until a leader reconnects in the
// field. Add a case here and to all three siblings, never to just one.
func TestSuccessorVersionVectors(t *testing.T) {
	vectors := []struct {
		name   string
		header string
		want   string
	}{
		{
			"the header the worker emits",
			`<https://www.sliccy.ai/join/fresh-tray.deadbeef>; rel="successor-version"`,
			"https://www.sliccy.ai/join/fresh-tray.deadbeef",
		},
		{
			"buried in the standard rel set applySliccLinks appends",
			`<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version", ` +
				`<https://www.sliccy.ai/.well-known/api-catalog>; rel="api-catalog", ` +
				`<https://www.sliccy.ai/status>; rel="status"; type="application/json"`,
			"https://www.sliccy.ai/join/fresh.beef",
		},
		{
			"standard rel set first, successor last",
			`<https://www.sliccy.ai/status>; rel="status", ` +
				`<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version"`,
			"https://www.sliccy.ai/join/fresh.beef",
		},
		{
			"unquoted rel token",
			`<https://www.sliccy.ai/join/a.b>; rel=successor-version`,
			"https://www.sliccy.ai/join/a.b",
		},
		{
			"rel as a space-separated token list",
			`<https://www.sliccy.ai/join/a.b>; rel="alternate successor-version"`,
			"https://www.sliccy.ai/join/a.b",
		},
		{
			"rel matching is case-insensitive (RFC 8288 3.3)",
			`<https://www.sliccy.ai/join/a.b>; REL="Successor-Version"`,
			"https://www.sliccy.ai/join/a.b",
		},
		{
			"a comma inside a quoted parameter is not a value separator",
			`<https://www.sliccy.ai/x>; rel="alternate"; title="one, two", ` +
				`<https://www.sliccy.ai/join/a.b>; rel="successor-version"`,
			"https://www.sliccy.ai/join/a.b",
		},
		{
			"a semicolon inside a quoted parameter does not forge a rel",
			`<https://www.sliccy.ai/x>; title="q; rel=successor-version"`,
			"",
		},
		{
			"a different version rel is not a successor",
			`<https://www.sliccy.ai/join/old.b>; rel="predecessor-version"`,
			"",
		},
		{
			"successor-version as a prefix of another token does not match",
			`<https://www.sliccy.ai/join/a.b>; rel="successor-version-2"`,
			"",
		},
		{
			"a relative target is rejected — a replacement tray is always absolute",
			`</join/a.b>; rel="successor-version"`,
			"",
		},
		{
			"a percent-encoded target survives verbatim",
			`<https://www.sliccy.ai/join/fresh%3Eevil.deadbeef>; rel="successor-version"`,
			"https://www.sliccy.ai/join/fresh%3Eevil.deadbeef",
		},
		{"an empty header", "", ""},
		{"a garbage header", "not a link header", ""},
	}

	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			header := http.Header{}
			if v.header != "" {
				header.Set("Link", v.header)
			}
			if got := SuccessorVersionFromLinkHeader(header); got != v.want {
				t.Fatalf("SuccessorVersionFromLinkHeader() = %q, want %q", got, v.want)
			}
		})
	}
}

func TestSuccessorVersionNoHeader(t *testing.T) {
	if got := SuccessorVersionFromLinkHeader(nil); got != "" {
		t.Fatalf("nil header = %q, want empty", got)
	}
	if got := SuccessorVersionFromLinkHeader(http.Header{}); got != "" {
		t.Fatalf("empty header = %q, want empty", got)
	}
}

func TestSuccessorVersionMergesRepeatedHeaderInstances(t *testing.T) {
	header := http.Header{}
	header.Add("Link", `<https://www.sliccy.ai/status>; rel="status"`)
	header.Add("Link", `<https://www.sliccy.ai/join/a.b>; rel="successor-version"`)
	if got := SuccessorVersionFromLinkHeader(header); got != "https://www.sliccy.ai/join/a.b" {
		t.Fatalf("got %q", got)
	}
}

func TestSuccessorVersionReturnsTheFirstOfSeveral(t *testing.T) {
	header := http.Header{}
	header.Set("Link", `<https://www.sliccy.ai/join/first.b>; rel="successor-version", `+
		`<https://www.sliccy.ai/join/second.b>; rel="successor-version"`)
	if got := SuccessorVersionFromLinkHeader(header); got != "https://www.sliccy.ai/join/first.b" {
		t.Fatalf("got %q", got)
	}
}
