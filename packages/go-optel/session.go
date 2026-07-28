package optel

import (
	"crypto/rand"
	"fmt"
)

// GenerateSessionID returns a fresh 9-character session id, matching the
// helix-rum-js / swift-optel derivation: a random v4 UUID formatted as the
// canonical dashed lowercase string, then the last 9 characters (entirely
// within the trailing 12-hex-digit group, so none of the dashes survive).
func GenerateSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	uuid := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	if len(uuid) <= 9 {
		return uuid
	}
	return uuid[len(uuid)-9:]
}
