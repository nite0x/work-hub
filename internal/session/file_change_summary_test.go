package session

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFileChangeSummaryPreservesFilesBeyondPreviewLimit(t *testing.T) {
	raw := `{"id":"edit","type":"fileChange","status":"completed","changes":[{"path":"+unusual file","diff":"--- a/file\n+++ b/file\n@@ -1 +1,2 @@\n-old\n+++content\n+new"},{"path":"no-extension","diff":"+ok"}]}`
	var item codexHistoryItem
	if err := json.Unmarshal([]byte(raw), &item); err != nil {
		t.Fatal(err)
	}
	item.Changes[0].Diff += "\n+" + strings.Repeat("x", 300*1024)
	entry, ok := visibleHistoryEntry(codexHistoryEntry{TurnID: "turn", Item: item})
	if !ok || len(entry.FileChanges) != 2 {
		t.Fatalf("missing files: %+v", entry.FileChanges)
	}
	if entry.FileChanges[0].Additions != 3 || entry.FileChanges[0].Deletions != 1 {
		t.Fatal(entry.FileChanges[0])
	}
	if strings.Contains(entry.Text, "no-extension") {
		t.Fatal("expected bounded text preview")
	}
	if entry.FileChanges[1].Path != "no-extension" || entry.FileChanges[1].Additions != 1 {
		t.Fatal(entry.FileChanges[1])
	}
}
