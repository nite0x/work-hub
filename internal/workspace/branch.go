package workspace

import (
	"context"
	"strings"
)

// DefaultBranchSource is only a suggestion. An explicit source is never replaced.
func DefaultBranchSource(ctx context.Context, path string) string {
	refs := []string{"refs/heads/master", "refs/heads/main", "refs/remotes/origin/master", "refs/remotes/origin/main"}
	raw, _ := Git(ctx, path, append([]string{"for-each-ref", "--format=%(refname)"}, refs...)...)
	available := map[string]bool{}
	for _, ref := range strings.Fields(raw) {
		available[ref] = true
	}
	for _, ref := range refs {
		if available[ref] {
			return ref
		}
	}
	return "HEAD"
}
