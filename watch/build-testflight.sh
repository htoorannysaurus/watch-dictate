#!/usr/bin/env bash
# Archive Dictate and upload it to App Store Connect for TestFlight. Runs on the Mac in
# the GUI login session (archiving signs locally); trigger from the home server with
#   ssh your-mac 'echo watchdictate-testflight > ~/.ios-build-trigger'
# Auth is an App Store Connect API key.
set -euo pipefail
cd "$(dirname "$0")"
. "$HOME/.appstoreconnect/api.env"   # ASC_KEY_ID, ASC_ISSUER_ID
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY"
      -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
XCODEGEN="${XCODEGEN:-$HOME/.local/xcodegen/bin/xcodegen}"
[[ -x "$XCODEGEN" ]] || XCODEGEN="$(command -v xcodegen || echo /opt/homebrew/bin/xcodegen)"
BUILD="$(date +%y%m%d%H%M)"   # every upload needs a new build number
OUT="/tmp/watchdictate-testflight"
rm -rf "$OUT"; mkdir -p "$OUT"

"$XCODEGEN" generate
echo "==> archiving build $BUILD"
xcodebuild -project WatchDictate.xcodeproj -scheme Dictate -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$OUT/WatchDictate.xcarchive" \
  "${AUTH[@]}" CURRENT_PROJECT_VERSION="$BUILD" archive

cat > "$OUT/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>destination</key><string>upload</string>
    <key>teamID</key><string>YOUR_TEAM_ID</string>
    <key>signingStyle</key><string>automatic</string>
    <key>manageAppVersionAndBuildNumber</key><false/>
    <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST

echo "==> exporting and uploading to App Store Connect"
xcodebuild -exportArchive -archivePath "$OUT/WatchDictate.xcarchive" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
echo "Uploaded build $BUILD."
