package workspace

import "errors"

// SessionConflictError means another owner was positively identified. Probe
// failures must remain ordinary errors so they cannot interrupt an active turn.
type SessionConflictError struct {
	Message string
}

func (e *SessionConflictError) Error() string { return e.Message }

func IsSessionConflict(err error) bool {
	var conflict *SessionConflictError
	return errors.As(err, &conflict)
}
