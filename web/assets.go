package web

import "embed"

// Assets contains the complete browser UI, including feature subdirectories.
//
//go:embed index.html workspace.html *.ico *.png *.svg core features chat ui/*.js ui/*.css
var Assets embed.FS
