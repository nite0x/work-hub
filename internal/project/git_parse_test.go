package project

import (
	"testing"
)

func TestNulParsingAndRenameCounts(t *testing.T) {
	raw := "worktree /tmp/with space\x00HEAD abc\x00branch refs/heads/master\x00\x00worktree /tmp/line\nbreak\x00HEAD def\x00detached\x00locked reason\x00\x00"
	trees := ParseWorktrees(raw)
	if len(trees) != 2 || trees[0].Path != "/tmp/with space" || !trees[1].Detached || !trees[1].Locked || trees[1].Path != "/tmp/line\nbreak" {
		t.Fatalf("parse failure %+v", trees)
	}
	if n := DirtyCount("R  new name\x00old name\x00?? untracked\x00"); n != 2 {
		t.Fatalf("rename counted incorrectly: %d", n)
	}
}
