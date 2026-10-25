package session

import (
	"context"
	"net"
)

// macOS uses the normal terminal launcher. The Linux TUI relay is unavailable:
// no peer PID is granted and the relay rejects the connection.
func bridgePeerContext(ctx context.Context, _ net.Conn) context.Context { return ctx }
