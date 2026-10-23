package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"time"

	"github.com/gorilla/websocket"
)

// RelayDaemon carries the app-server protocol over a private helper's stdio.
// RPC replies, deltas and approval requests must never be coalesced.
func RelayDaemon(ctx context.Context, input io.ReadCloser, output io.Writer) error {
	conn, err := DialDaemon(ctx)
	if err != nil {
		return err
	}
	return relayJSONL(ctx, conn, input, output)
}

func relayJSONL(ctx context.Context, conn *websocket.Conn, input io.ReadCloser, output io.Writer) error {
	defer conn.Close()
	defer input.Close()
	done := make(chan error, 2)
	go func() {
		scan := bufio.NewScanner(input)
		scan.Buffer(make([]byte, 4096), 16<<20)
		for scan.Scan() {
			if !json.Valid(scan.Bytes()) {
				done <- io.ErrUnexpectedEOF
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, scan.Bytes()); err != nil {
				done <- err
				return
			}
		}
		done <- scan.Err()
	}()
	go func() {
		conn.SetReadLimit(16 << 20)
		encoder := json.NewEncoder(output)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				done <- err
				return
			}
			if err := encoder.Encode(json.RawMessage(raw)); err != nil {
				done <- err
				return
			}
		}
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
