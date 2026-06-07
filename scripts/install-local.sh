#!/bin/bash
# Build the Mac app, gracefully stop any running instance, and replace the
# installed copy at ~/Applications/Meeting Notes.app.
#
# Run from the repo root via:  npm run install:local

set -e

APP_NAME="Meeting Notes"
SRC="release/mac-arm64/${APP_NAME}.app"
DEST="$HOME/Applications/${APP_NAME}.app"

echo "→ Building app…"
npm run package

# Quit any running instance so we don't replace a binary mid-execution.
# `osascript quit` is cleaner than killall (gives the app a chance to clean
# up). Fall back to killall if osascript can't reach it.
if pgrep -x "${APP_NAME}" > /dev/null 2>&1 || pgrep -f "${APP_NAME}.app" > /dev/null 2>&1; then
  echo "→ Quitting running instance…"
  osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
  sleep 1
  # Force-kill anything still hanging on.
  killall "${APP_NAME}" 2>/dev/null || true
fi

# Make sure ~/Applications exists (first-time installs).
mkdir -p "$HOME/Applications"

echo "→ Installing to ${DEST}…"
rm -rf "${DEST}"
cp -R "${SRC}" "${DEST}"

echo "✓ Installed."
echo "  Launch:  open \"${DEST}\""
echo "  Or:      Cmd+Space → Meeting Notes"
