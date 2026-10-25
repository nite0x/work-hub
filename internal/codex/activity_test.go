package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRolloutActivityNativeLifecycle(t *testing.T) {
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	started := `{"timestamp":"2026-10-25T01:29:25Z","type":"event_msg","payload":{"type":"task_started","turn_id":"native-turn"}}` + "\n"
	if err := os.WriteFile(p, []byte(started+strings.Repeat(`{"type":"event_msg","payload":{"type":"item_completed"}}`+"\n", 3000)), 0600); err != nil {
		t.Fatal(err)
	}
	a := RolloutActivity(p)
	if a.Status != "running" || a.TurnID != "native-turn" {
		t.Fatal(a)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"native-turn"}}`)
	f.Close()
	if RolloutActivity(p).Status != "running" {
		t.Fatal("partial write must not imply completion")
	}
	f, _ = os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString("\n")
	f.Close()
	if RolloutActivity(p).Status != "completed" {
		t.Fatal(RolloutActivity(p))
	}
	if err := os.WriteFile(p, []byte(started), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	os.Chtimes(p, old, old)
	if RolloutActivity(p).Status != "unknown" {
		t.Fatal("abandoned turn must be uncertain")
	}
}
