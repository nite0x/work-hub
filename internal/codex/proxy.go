package codex

import (
	"context"
	"io"
	"net"
	"sync"

	"worktree-hub/internal/platform"
)

// The CLI proxy carries raw WebSocket bytes, not JSONL. Let the native CLI
// handle the Windows control socket; net.Pipe supplies real I/O deadlines to
// the WebSocket client and cancellation closes both subprocess pipes.
func dialCodexProxy(ctx context.Context, socket string) (net.Conn, error) {
	processCtx, cancel := context.WithCancel(ctx)
	cmd := Command(processCtx, "app-server", "proxy", "--sock", socket)
	platform.HideCommand(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		input.Close()
		output.Close()
		cancel()
		return nil, err
	}
	client, relay := net.Pipe()
	var once sync.Once
	done := make(chan struct{})
	closeAll := func() {
		once.Do(func() {
			cancel()
			_ = client.Close()
			_ = relay.Close()
			_ = input.Close()
			_ = output.Close()
			_ = cmd.Wait()
			close(done)
		})
	}
	go func() { _, _ = io.Copy(input, relay); closeAll() }()
	go func() { _, _ = io.Copy(relay, output); closeAll() }()
	go func() {
		select {
		case <-ctx.Done():
			closeAll()
		case <-done:
		}
	}()
	return &codexProxyConn{Conn: client, shutdown: closeAll}, nil
}

type codexProxyConn struct {
	net.Conn
	shutdown func()
}

func (c *codexProxyConn) Close() error { c.shutdown(); return nil }
