

















package computer

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)



var ErrUnsupported = errors.New("native computer capture is macOS-only")



type Mode int

const (
	
	ModeOff Mode = iota
	
	ModeBestEffort
	
	
	ModeRequire
)



func ParseMode(arg string) (mode Mode, ok bool) {
	name, value, hasValue := strings.Cut(arg, "=")
	if name != "--computer" {
		return ModeOff, false
	}
	if !hasValue {
		return ModeBestEffort, true
	}
	switch value {
	case "require":
		return ModeRequire, true
	case "auto", "":
		return ModeBestEffort, true
	default:
		return ModeOff, false
	}
}













func NewPairID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("minting a computer pairing id: %w", err)
	}
	return "pair-" + hex.EncodeToString(buf), nil
}


type Grants struct {
	
	ScreenRecording bool `json:"screenRecording"`
	
	
	Accessibility bool `json:"accessibility"`
}


func (g Grants) Summary() string {
	return fmt.Sprintf("Screen Recording: %s · Accessibility: %s",
		grantWord(g.ScreenRecording), grantWord(g.Accessibility))
}


func (g Grants) Complete() bool { return g.ScreenRecording && g.Accessibility }

func grantWord(granted bool) string {
	if granted {
		return "granted"
	}
	return "not granted"
}


type Options struct {
	
	
	JoinURL string
	
	PairID string
	
	Logf func(format string, args ...any)
	
	
	
	OnExit func(reason string)
}
