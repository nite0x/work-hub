package session

import (
	"encoding/base64"
	"strings"
	"testing"
)

const testChatPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII="

func TestChatImagesReachCodexOnNewAndExistingSessions(t *testing.T) {
	for _, fresh := range []bool{false, true} {
		name := "existing"
		if fresh {
			name = "new"
		}
		t.Run(name, func(t *testing.T) {
			a, q, c, endpoint := chatFixture(t)
			if fresh {
				endpoint = "/api/requirements/" + q.ID + "/sessions/new"
			}
			// Exercise the chat-specific body limit with a screenshot over 1 MiB.
			data, _ := base64.StdEncoding.DecodeString(strings.SplitN(testChatPNG, ",", 2)[1])
			image := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append(data, make([]byte, 1<<20)...))
			input := map[string]any{"text": "", "images": []string{image}, "request_id": "image-only"}
			if code, raw := call(t, a, "POST", endpoint, input); code != 202 {
				t.Fatalf("%d %s", code, raw)
			}
			awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
			c.mu.Lock()
			parts := c.startParams["input"].([]any)
			c.mu.Unlock()
			if len(parts) != 1 || parts[0].(map[string]any)["type"] != "image" || parts[0].(map[string]any)["url"] != image {
				t.Fatal("image missing from Codex turn input")
			}
			if code, _ := call(t, a, "POST", endpoint, input); code != 200 {
				t.Fatal("image retry was not idempotent", code)
			}
			c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
			awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
		})
	}
}

func TestInvalidChatImagesNeverStartCodex(t *testing.T) {
	oversized := "data:image/png;base64," + strings.Repeat("A", base64.StdEncoding.EncodedLen(4<<20)+4)
	for _, images := range [][]string{
		{"https://example.com/image.png"},
		{"data:image/svg+xml;base64,PHN2Zy8+"},
		{"data:image/png;base64,invalid!"},
		{"data:image/png;base64,SGVsbG8="},
		{strings.Replace(testChatPNG, "image/png", "image/jpeg", 1)},
		{testChatPNG, testChatPNG, testChatPNG, testChatPNG, testChatPNG},
		{oversized},
	} {
		a, q, c, endpoint := chatFixture(t)
		for _, path := range []string{endpoint, "/api/requirements/" + q.ID + "/sessions/new"} {
			if code, _ := call(t, a, "POST", path, map[string]any{"text": "检查截图", "images": images, "request_id": "invalid"}); code != 400 {
				t.Fatalf("invalid image accepted: %d", code)
			}
		}
		c.mu.Lock()
		calls := len(c.methods)
		c.mu.Unlock()
		if calls != 0 {
			t.Fatal("Codex called before rejecting invalid images")
		}
	}
}

func TestChatImageTotalSizeAndMixedInput(t *testing.T) {
	data, _ := base64.StdEncoding.DecodeString(strings.SplitN(testChatPNG, ",", 2)[1])
	large := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append(data, make([]byte, (3<<20)-len(data))...))
	if err := validateChatImages([]string{large, large, large}); err == nil {
		t.Fatal("total size limit was not enforced")
	}
	parts := chatTurnInput("检查截图", []string{testChatPNG, testChatPNG})
	if len(parts) != 3 || parts[0].(map[string]any)["text"] != "检查截图" || parts[2].(map[string]any)["url"] != testChatPNG {
		t.Fatal("mixed input lost text or images")
	}
}
