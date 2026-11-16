#!/usr/bin/env bash
# Build the iPhone app (with the watch app inside) and install it on the user's iPhone.
# The iPhone then installs the watch app on the paired watch, so this works even
# when the watch itself isn't set up for development. Runs in the Mac GUI session
# (the ios-build-agent, trigger "watchdictate-phone"), never over SSH.
set -euo pipefail
if [[ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]]; then
  echo 'Device signing is prohibited over SSH. Run this script in the Mac GUI login session.' >&2
  exit 1
fi
cd "$(dirname "$0")"
PHONE_ID="${PHONE_ID:?set PHONE_ID to your iPhone's device id}"
XCODEGEN="${XCODEGEN:-$HOME/.local/xcodegen/bin/xcodegen}"
if [[ ! -x "$XCODEGEN" ]]; then XCODEGEN="$(command -v xcodegen)"; fi
DD="${DERIVED_DATA_PATH:-$HOME/Library/Developer/Xcode/DerivedData/WatchDictate-phone}"
# Release, with a real build number, so what lands on the devices is the same app TestFlight would
# give: it reports its version to the server ("watch app is now ..."), and the status widget updates.
# A Debug build numbered (1) did neither: the server takes (1) for a simulator and ignores it, which
# is how 1.0.45 sat on the watch from Nov 11 while the server still said 1.0.44.
BUILD="$(date +%y%m%d%H%M)"
"$XCODEGEN" generate
echo "==> building $BUILD for the iPhone"
xcodebuild -project WatchDictate.xcodeproj -scheme Dictate \
  -configuration Release -destination "platform=iOS,id=$PHONE_ID" \
  -derivedDataPath "$DD" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  CURRENT_PROJECT_VERSION="$BUILD" build
APP="$DD/Build/Products/Release-iphoneos/Dictate.app"
xcrun devicectl device install app --device "$PHONE_ID" "$APP"
echo "Installed Dictate build $BUILD on the iPhone; the watch app follows from the phone."
