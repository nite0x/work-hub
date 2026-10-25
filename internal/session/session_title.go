package session

import (
	"regexp"
	"strings"
	"unicode"
)

var (
	titleImage   = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	titleLink    = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	titleList    = regexp.MustCompile(`^(?:[-+*]|[0-9]+[.)])\s+(?:\[[ xX]\]\s*)?`)
	titleContext = regexp.MustCompile(`^<([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^>]*)?>`)
)

// initialSessionTitle is a deterministic label, not a summary. Only the first
// useful prose line is considered; code, attachments and context blocks stay out.
func initialSessionTitle(text string) string {
	var fence, contextTag string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(line, fence) {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
			fence = line[:3]
			continue
		}
		if contextTag != "" {
			if strings.Contains(line, "</"+contextTag+">") {
				contextTag = ""
			}
			continue
		}
		if tag := titleContext.FindStringSubmatch(line); len(tag) > 0 {
			if !strings.HasSuffix(tag[0], "/>") && !strings.Contains(line, "</"+tag[1]+">") {
				contextTag = tag[1]
			}
			continue
		}
		if strings.HasPrefix(line, "</") || strings.HasPrefix(line, "<!--") {
			continue
		}
		line = strings.TrimLeft(line, "#> \t")
		line = titleList.ReplaceAllString(line, "")
		line = titleImage.ReplaceAllString(line, "")
		line = titleLink.ReplaceAllString(line, "$1")
		line = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "").Replace(line)
		line = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
				return -1
			}
			return r
		}, line)
		line = strings.Join(strings.Fields(line), " ")
		if strings.Trim(line, " -*_~#>") == "" || strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
			continue
		}
		runes := []rune(line)
		if len(runes) > 28 {
			return strings.TrimSpace(string(runes[:27])) + "…"
		}
		return line
	}
	return ""
}
