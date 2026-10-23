package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRelayKeepsEveryDeltaAndApprovalReply(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var request map[string]any
		if conn.ReadJSON(&request) != nil {
			return
		}
		_ = conn.WriteJSON(map[string]any{"id": request["id"], "result": map[string]any{}})
		for i := 0; i < 512; i++ {
			if conn.WriteJSON(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"index": i, "delta": "片"}}) != nil {
				return
			}
		}
		_ = conn.WriteJSON(map[string]any{"method": "item/commandExecution/requestApproval", "id": "approval", "params": map[string]any{}})
		if conn.ReadJSON(&request) != nil {
			return
		}
		_ = conn.WriteJSON(map[string]any{"method": "reply/received", "params": request})
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	input, send := io.Pipe()
	receive, output := io.Pipe()
	defer receive.Close()
	defer send.Close()
	defer output.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- relayJSONL(ctx, conn, input, output) }()
	go func() { _ = json.NewEncoder(send).Encode(map[string]any{"id": 1, "method": "initialize"}) }()
	scan := bufio.NewScanner(receive)
	index := 0
	approved := false
	for scan.Scan() {
		var event struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Index  int            `json:"index"`
				Result map[string]any `json:"result"`
			} `json:"params"`
		}
		if json.Unmarshal(scan.Bytes(), &event) != nil {
			t.Fatal("invalid JSONL")
		}
		switch event.Method {
		case "item/agentMessage/delta":
			if event.Params.Index != index {
				t.Fatalf("lost delta: %d != %d", event.Params.Index, index)
			}
			index++
		case "item/commandExecution/requestApproval":
			if string(event.ID) != `"approval"` {
				t.Fatal("lost RPC id")
			}
			go func() {
				_ = json.NewEncoder(send).Encode(map[string]any{"id": "approval", "result": map[string]any{"decision": "decline"}})
			}()
		case "reply/received":
			approved = event.Params.Result["decision"] == "decline"
		}
		if approved {
			break
		}
	}
	if index != 512 || !approved {
		t.Fatalf("relay: %d deltas, reply=%v", index, approved)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel did not release relay")
	}
}
