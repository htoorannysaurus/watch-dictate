#!/usr/bin/env bash
# Build Dictate and install it on the user's watch. Runs on the Mac in the GUI login
# session (Terminal.app or the ios-build-agent LaunchAgent), never over SSH: codesign
# needs the login keychain. Adapted from interval-buzz/build-device.sh.
set -euo pipefail
if [[ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]]; then
  echo 'Device signing is prohibited over SSH. Run this script in the Mac GUI login session.' >&2
  exit 1
fi
cd "$(dirname "$0")"
DEVICE_ID="${DEVICE_ID:-}" # Auto-select only when exactly one physical watch is discovered.
XCODEGEN="${XCODEGEN:-$HOME/.local/xcodegen/bin/xcodegen}"
if [[ ! -x "$XCODEGEN" ]]; then XCODEGEN="$(command -v xcodegen)"; fi
DD="${DERIVED_DATA_PATH:-$HOME/Library/Developer/Xcode/DerivedData/WatchDictate-device}"
CHECK="$(mktemp -d)"
trap 'rm -rf "$CHECK"' EXIT
"$XCODEGEN" generate
xcrun devicectl list devices --json-output "$CHECK/devices.json"
xcodebuild -project WatchDictate.xcodeproj -scheme WatchDictate -showdestinations > "$CHECK/destinations.txt"
python3 scripts/select-watch.py "$CHECK/devices.json" "$CHECK/destinations.txt" "$DEVICE_ID" > "$CHECK/target.txt"
WATCH_UDID="$(sed -n '1p' "$CHECK/target.txt")"
CORE_DEVICE_ID="$(sed -n '2p' "$CHECK/target.txt")"
xcodebuild -project WatchDictate.xcodeproj -scheme WatchDictate \
  -configuration Debug -destination "platform=watchOS,id=$WATCH_UDID" \
  -derivedDataPath "$DD" -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
APP="$DD/Build/Products/Debug-watchos/WatchDictate.app"
xcrun devicectl device install app --device "$CORE_DEVICE_ID" "$APP"
echo 'Installed Dictate on the watch.'
