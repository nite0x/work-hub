package workspace

import (
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

func agentTestPipe(t *testing.T, hooks AgentHooks) (func(Request), func() Response) {
	t.Helper()
	in, input := io.Pipe()
	output, out := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- RunAgent(in, out, hooks)
		out.Close()
	}()
	responses := make(chan Response, agentRequestLimit+agentWatchLimit+8)
	go func() {
		defer close(responses)
		decoder := json.NewDecoder(output)
		for {
			var response Response
			if err := decoder.Decode(&response); err != nil {
				return
			}
			responses <- response
		}
	}()
	t.Cleanup(func() {
		input.Close()
		defer output.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("helper shutdown: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("helper did not cancel active subscriptions on shutdown")
		}
	})
	encoder := json.NewEncoder(input)
	return func(request Request) {
			t.Helper()
			if err := encoder.Encode(request); err != nil {
				t.Fatal(err)
			}
		}, func() Response {
			t.Helper()
			select {
			case response, ok := <-responses:
				if !ok {
					t.Fatal("helper response stream closed")
				}
				return response
			case <-time.After(3 * time.Second):
				t.Fatal("helper response timed out")
				return Response{}
			}
		}
}

func TestAgentOrdinaryRequestsDoNotBlockSubscriptions(t *testing.T) {
	entered := make(chan struct{}, agentRequestLimit)
	release := make(chan struct{})
	send, receive := agentTestPipe(t, AgentHooks{
		TerminalConflict: func(string, string) error {
			entered <- struct{}{}
			<-release
			return nil
		},
		WatchHistory: func(ctx context.Context, _ string, emit func(json.RawMessage) error) error {
			if err := emit(json.RawMessage(`{"connected":true}`)); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		},
	})
	defer close(release)
	for id := uint64(1); id <= agentRequestLimit; id++ {
		send(Request{ID: id, Op: "session-conflict"})
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("ordinary request did not start")
		}
	}
	send(Request{ID: agentRequestLimit + 1, Op: "identity"})
	if response := receive(); response.ID != agentRequestLimit+1 || response.Code != "busy" {
		t.Fatalf("ordinary requests must remain bounded: %+v", response)
	}
	send(Request{ID: agentRequestLimit + 2, Op: "session-watch"})
	if response := receive(); response.ID != agentRequestLimit+2 || !response.More || response.Error != "" {
		t.Fatalf("ordinary pool blocked subscription: %+v", response)
	}
}
