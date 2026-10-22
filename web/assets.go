package web

import "embed"

// Assets contains the complete browser UI, including feature subdirectories.
//
//go:embed index.html *.ico *.png *.svg core features
var Assets embed.FS
