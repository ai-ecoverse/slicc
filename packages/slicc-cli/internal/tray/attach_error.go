package tray

import (
	"errors"
	"fmt"
)

const (
	
	
	AttachCodeSupersededMissingJoin = "TRAY_SUPERSEDED_MISSING_JOIN_URL"
	
	
	AttachCodeSupersededChainExhausted = "TRAY_SUPERSEDED_CHAIN_EXHAUSTED"
)


type AttachError struct {
	Code    string
	Message string
}

func (e *AttachError) Error() string {
	return fmt.Sprintf("tray attach failed (%s): %s", e.Code, e.Message)
}



func IsSupersedeChainExhausted(err error) bool {
	var ae *AttachError
	return errors.As(err, &ae) && ae.Code == AttachCodeSupersededChainExhausted
}



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
