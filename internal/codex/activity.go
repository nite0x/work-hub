package codex

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// Activity is display evidence, not permission to control another Codex client.
type Activity struct {
	Status    string    `json:"status"`
	TurnID    string    `json:"turn_id,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
}
type activityFile struct {
	size     int64
	modified time.Time
	activity Activity
}

var activityFiles = struct {
	sync.Mutex
	files map[string]activityFile
}{files: map[string]activityFile{}}

// Native desktop runs may use a different app-server instance. In that case
// thread/read says notLoaded and turns/list synthesizes interrupted. The
// append-only rollout's lifecycle events still describe the native turn.
func RolloutActivity(path string) Activity {
	unknown := Activity{Status: "unknown"}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return unknown
	}
	activityFiles.Lock()
	cached, ok := activityFiles.files[path]
	activityFiles.Unlock()
	if ok && cached.size == info.Size() && cached.modified.Equal(info.ModTime()) {
		return freshActivity(cached.activity, info.ModTime())
	}
	f, err := os.Open(path)
	if err != nil {
		return unknown
	}
	defer f.Close()
	result := unknown
	for size := int64(64 << 10); ; size *= 2 {
		start := max(int64(0), info.Size()-size)
		raw, err := io.ReadAll(io.LimitReader(io.NewSectionReader(f, start, info.Size()-start), 16<<20))
		if err != nil {
			return unknown
		}
		if start > 0 {
			if n := bytes.IndexByte(raw, '\n'); n >= 0 {
				raw = raw[n+1:]
			} else {
				raw = nil
			}
		}
		lines := bytes.Split(raw, []byte{'\n'})
		for i := len(lines) - 2; i >= 0; i-- {
			var event struct {
				Timestamp time.Time `json:"timestamp"`
				Type      string    `json:"type"`
				Payload   struct {
					Type   string `json:"type"`
					TurnID string `json:"turn_id"`
				}
			}
			if json.Unmarshal(lines[i], &event) != nil || event.Type != "event_msg" {
				continue
			}
			status := ""
			switch event.Payload.Type {
			case "task_started":
				status = "running"
			case "task_complete":
				status = "completed"
			case "turn_aborted":
				status = "interrupted"
			case "task_failed":
				status = "failed"
			}
			if status != "" {
				result = Activity{Status: status, TurnID: event.Payload.TurnID, StartedAt: event.Timestamp}
				break
			}
		}
		if result.Status != "unknown" || start == 0 || size >= 16<<20 {
			break
		}
	}
	activityFiles.Lock()
	if len(activityFiles.files) > 2048 {
		activityFiles.files = map[string]activityFile{}
	}
	activityFiles.files[path] = activityFile{info.Size(), info.ModTime(), result}
	activityFiles.Unlock()
	return freshActivity(result, info.ModTime())
}
func freshActivity(a Activity, modified time.Time) Activity {
	// An abandoned/crashed turn is uncertain, never proof that it has stopped.
	if a.Status == "running" && time.Since(modified) > 15*time.Minute {
		a.Status = "unknown"
	}
	return a
}
