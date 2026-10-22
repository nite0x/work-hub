#!/bin/sh
set -eu
# dpkg runs as root; do not open a root profile or send signals to users' Git
# processes. Require the user to safely stop their own desktop and backend.
case "${1:-}" in
  install|upgrade|remove|deconfigure)
    for entry in /proc/[0-9]*/exe; do
      executable=$(readlink "$entry" 2>/dev/null || true)
      case "$executable" in
        /usr/bin/work-hub|/usr/bin/work-hub-backend|'/usr/bin/work-hub (deleted)'|'/usr/bin/work-hub-backend (deleted)')
          echo 'Work Hub is running. Choose "Exit and stop backend" in the application menu, then retry installation/removal.' >&2
          exit 1
          ;;
      esac
    done
    ;;
esac
exit 0
