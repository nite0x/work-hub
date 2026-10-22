package session

import (
	"context"
	"net"
)

// macOS desktop sessions are read-only. The Linux TUI relay is intentionally
// unavailable: no peer PID is granted and the relay rejects the connection.
func bridgePeerContext(ctx context.Context, _ net.Conn) context.Context { return ctx }
