#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
output="${1:-bin/windows-amd64}"
mkdir -p "$output/agents"
# Embed the same multi-resolution icon used by the web UI.
go run github.com/tc-hib/go-winres@v0.3.3 make --arch amd64 --in winres/winres.json
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags '-s -w -H windowsgui' -o "$output/WorkHub.exe" .
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' -o "$output/agents/worktree-hub-linux-amd64" .
printf '\357\273\277' > "$output/Install.ps1"
cat scripts/install-desktop.ps1 >> "$output/Install.ps1"
cp scripts/install-desktop.cmd "$output/Install.cmd"
cp README.md "$output/README.md"
cp web/work-hub.ico "$output/WorkHub.ico"
mkdir -p "$output/licenses"
cp "$(go env GOROOT)/LICENSE" "$output/licenses/Go-LICENSE"
while IFS='|' read -r moduleName moduleDir; do
  [ -n "$moduleDir" ] || continue
  for license in "$moduleDir"/LICENSE* "$moduleDir"/COPYING*; do
    [ -f "$license" ] || continue
    install -m 644 "$license" "$output/licenses/${moduleName//\//_}-$(basename "$license")"
  done
done < <(go list -m -f '{{.Path}}|{{.Dir}}' all)
printf 'Windows release: %s\n' "$output"
