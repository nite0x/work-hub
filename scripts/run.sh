#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
npm run chat:build
mkdir -p bin
go build -o bin/work-hub .
exec ./bin/work-hub "$@"
