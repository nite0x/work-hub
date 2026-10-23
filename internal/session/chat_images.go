package session

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
)

const chatRequestLimit = 12 << 20

// Inline images work across local and remote Codex connections without sharing
// browser file paths or creating temporary files in the task's repositories.
func validateChatImages(images []string) error {
	if len(images) > 4 {
		return fmt.Errorf("每条消息最多附加 4 张图片")
	}
	total := 0
	for _, image := range images {
		header, payload, ok := strings.Cut(image, ",")
		mime := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		if !ok || header != "data:"+mime+";base64" || (mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp") {
			return fmt.Errorf("图片必须是 PNG、JPEG、GIF 或 WebP 格式")
		}
		if len(payload) > base64.StdEncoding.EncodedLen(4<<20) {
			return fmt.Errorf("每张图片不能超过 4 MiB")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(payload)
		if err != nil || len(data) == 0 || http.DetectContentType(data) != mime {
			return fmt.Errorf("图片内容无效或与图片格式不匹配")
		}
		if len(data) > 4<<20 {
			return fmt.Errorf("每张图片不能超过 4 MiB")
		}
		total += len(data)
		if total > 8<<20 {
			return fmt.Errorf("每条消息的图片总大小不能超过 8 MiB")
		}
	}
	return nil
}

func chatTurnInput(text string, images []string) []any {
	input := []any{}
	if text != "" {
		input = append(input, map[string]any{"type": "text", "text": text})
	}
	for _, image := range images {
		input = append(input, map[string]any{"type": "image", "url": image})
	}
	return input
}
