package web

import (
	"io/fs"
	"strings"
	"testing"
)

func TestFileViewerAndLanguageChunksAreEmbedded(t *testing.T) {
	content, err := Assets.ReadFile("ui/files/file-display.js")
	if err != nil || len(content) == 0 {
		t.Fatalf("viewer missing from binary: %v", err)
	}
	chunks, err := fs.Glob(Assets, "ui/files/*.js")
	if err != nil || len(chunks) < 2 {
		t.Fatalf("viewer chunks missing: %d %v", len(chunks), err)
	}
	for _, chunk := range chunks {
		if strings.Contains(chunk, "typescript") {
			return
		}
	}
	t.Fatal("TypeScript highlighter is not embedded")
}
