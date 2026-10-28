package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Exercise the real JSONL transport without executing a user's Git or file writes.
func TestWorkspaceRetryHelper(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_RETRY_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	attempts, executions := 0, 0
	var previous Request
	valid := true
	for scanner.Scan() {
		var request Request
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			os.Exit(2)
		}
		response := Response{ID: request.ID}
		switch request.Op {
		case "cancel":
			continue
		case "identity":
			response.Data, _ = json.Marshal(Identity{Protocol: Protocol})
		case "stats":
			response.Data, _ = json.Marshal(map[string]any{"attempts": attempts, "executions": executions, "valid": valid})
		default:
			attempts++
			if attempts > 1 {
				valid = valid && request.ID > previous.ID && request.Timeout < previous.Timeout && string(request.Data) == string(previous.Data)
			}
			previous = request
			if request.Method == "disconnect" {
				os.Exit(0)
			}
			if request.Method == "always-busy" || request.Method != "conflict" && attempts <= 3 {
				response.Code, response.Error = "busy", ErrBusy.Error()
				if request.Method == "legacy" {
					response.Code = ""
				}
			} else {
				executions++
				if request.Method == "conflict" {
					response.Error = "此会话正在其他 Codex 客户端运行"
				}
			}
		}
		if encoder.Encode(response) != nil {
			os.Exit(3)
		}
	}
	os.Exit(0)
}

func retryTestClient(t *testing.T) *Client {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWorkspaceRetryHelper$")
	cmd.Env = append(os.Environ(), "WORKTREE_HUB_RETRY_HELPER=1")
	client, err := StartClient(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

func TestCallRetriesBusyBeforeExecutingWriteOnce(t *testing.T) {
	for _, mode := range []string{"recover", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			client := retryTestClient(t)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := client.Call(ctx, Request{Op: "write", Method: mode, Data: []byte("write once")}, nil); err != nil {
				t.Fatal(err)
			}
			var stats struct {
				Attempts, Executions int
				Valid                bool
			}
			if err := client.Call(ctx, Request{Op: "stats"}, &stats); err != nil {
				t.Fatal(err)
			}
			if stats.Attempts != 4 || stats.Executions != 1 || !stats.Valid {
				t.Fatalf("retry changed payload, reset deadline, reused ID, or replayed write: %+v", stats)
			}
		})
	}
}

func TestCallDoesNotRetryRealConflictOrDisconnect(t *testing.T) {
	for _, mode := range []string{"conflict", "disconnect"} {
		t.Run(mode, func(t *testing.T) {
			client := retryTestClient(t)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			err := client.Call(ctx, Request{Op: "write", Method: mode}, nil)
			if err == nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrBusy) {
				t.Fatalf("unexpected failure: %v", err)
			}
			client.mu.Lock()
			sequence := client.sequence
			client.mu.Unlock()
			if sequence != 2 { // identity followed by exactly one write attempt
				t.Fatalf("replayed failed operation: %d requests", sequence)
			}
			if mode == "conflict" && !strings.Contains(err.Error(), "其他 Codex") {
				t.Fatal(err)
			}
		})
	}
}

func TestCallBusyRetryRespectsCancellationAndDeadline(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[timeout], func(t *testing.T) {
			client := retryTestClient(t)
			ctx, cancel := context.WithCancel(context.Background())
			want := context.Canceled
			if timeout {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 120*time.Millisecond)
				want = context.DeadlineExceeded
			} else {
				timer := time.AfterFunc(120*time.Millisecond, cancel)
				defer timer.Stop()
			}
			defer cancel()
			if err := client.Call(ctx, Request{Op: "write", Method: "always-busy"}, nil); !errors.Is(err, want) {
				t.Fatalf("busy retry ignored cancellation: %v", err)
			}
			checkCtx, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			if err := client.Call(checkCtx, Request{Op: "identity"}, nil); err != nil {
				t.Fatal("cancelled retry broke other requests", err)
			}
			client.mu.Lock()
			pending := len(client.pending)
			client.mu.Unlock()
			if pending != 0 {
				t.Fatalf("cancelled retry leaked %d pending requests", pending)
			}
		})
	}
}

func TestCallBusyRetryIsBounded(t *testing.T) {
	client := retryTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	if err := client.Call(ctx, Request{Op: "write", Method: "always-busy"}, nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("persistent busy must stop retrying before caller deadline: %v", err)
	}
}
