package workspace

import (
	"regexp"
	"strings"
)

var invalidSlug = regexp.MustCompile(`[^a-z0-9_-]+`)
var ValidSlug = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func Slugify(s string) string {
	out := strings.Trim(invalidSlug.ReplaceAllString(strings.ToLower(s), "-"), "-_")
	if len(out) > 55 {
		out = strings.TrimRight(out[:55], "-_")
	}
	return out
}
