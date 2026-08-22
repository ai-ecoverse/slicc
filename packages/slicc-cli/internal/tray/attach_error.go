package tray

import (
	"errors"
	"fmt"
)

const (
	// AttachCodeSupersededMissingJoin is returned when the hub reports
	// TRAY_SUPERSEDED but omits a replacement joinUrl.
	AttachCodeSupersededMissingJoin = "TRAY_SUPERSEDED_MISSING_JOIN_URL"
	// AttachCodeSupersededChainExhausted is returned when the follower followed
	// maxSupersedeRetries replacements and the hub still reports superseded.
	AttachCodeSupersededChainExhausted = "TRAY_SUPERSEDED_CHAIN_EXHAUSTED"
)

// AttachError is a normalized tray attach failure from signaling.
type AttachError struct {
	Code    string
	Message string
}

func (e *AttachError) Error() string {
	return fmt.Sprintf("tray attach failed (%s): %s", e.Code, e.Message)
}

// IsSupersedeChainExhausted reports whether err is a bounded supersede-chain
// failure from tray.Dial.
func IsSupersedeChainExhausted(err error) bool {
	var ae *AttachError
	return errors.As(err, &ae) && ae.Code == AttachCodeSupersededChainExhausted
}

// IsSupersedeMissingJoin reports whether err is TRAY_SUPERSEDED without a
// replacement joinUrl.
func IsSupersedeMissingJoin(err error) bool {
	var ae *AttachError
	return errors.As(err, &ae) && ae.Code == AttachCodeSupersededMissingJoin
}

func supersedeChainExhaustedMessage() string {
	return fmt.Sprintf(
		"this session moved %d times without settling (possible redirect loop)",
		maxSupersedeRetries,
	)
}
