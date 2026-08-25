#!/bin/bash
# Fallback launcher: runs the same startup as CANVASync.app but inside a
# Terminal window, so first-run install output and errors are visible.
# Double-click this if the app itself won't open.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
REPO="$(cd "$(dirname "$SELF")" && pwd)"
echo "CANVASync — starting (logs also go to ~/Library/Logs/CANVASync-launcher.log)"
exec "$REPO/CANVASync.app/Contents/MacOS/CANVASync"
