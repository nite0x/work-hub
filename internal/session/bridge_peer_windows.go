package session

import (
	"context"
	"net"
)

// Desktop sessions are read-only; Windows terminals don't use the Linux TUI relay.
func bridgePeerContext(ctx context.Context, _ net.Conn) context.Context { return ctx }
