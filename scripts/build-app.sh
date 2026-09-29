#!/bin/zsh
set -euo pipefail
PROJECT_DIR="${0:A:h:h}"
cd "$PROJECT_DIR"
npm run build
APP_DIR="$PROJECT_DIR/release/声迹.app"
RES_DIR="$APP_DIR/Contents/Resources"
mkdir -p "$APP_DIR/Contents/MacOS" "$RES_DIR/app"
NODE_SOURCE="$(node -p 'process.execPath')"
cp "$NODE_SOURCE" "$RES_DIR/node"
chmod +x "$RES_DIR/node"
rm -rf "$RES_DIR/app/dist"
cp -R dist "$RES_DIR/app/"
for source in server.mjs connector-routes.mjs ai.mjs shared.mjs transcribe.mjs store.mjs cleanup.mjs record-qa.mjs package.json; do
  if [[ ! -f "$source" ]]; then print -u2 "缺少运行文件：$source"; exit 1; fi
  cp "$source" "$RES_DIR/app/"
done
if [[ ! -f connectors/index.mjs ]]; then print -u2 "缺少运行文件：connectors/index.mjs"; exit 1; fi
rm -rf "$RES_DIR/app/connectors"
cp -R connectors "$RES_DIR/app/connectors"
mkdir -p "$RES_DIR/app/native"
cp native/transcribe_audio.py "$RES_DIR/app/native/"
if [[ -f store.mjs ]]; then cp store.mjs "$RES_DIR/app/"; fi
swiftc -O native/Shengji.swift -o "$APP_DIR/Contents/MacOS/Shengji" -framework AppKit -framework WebKit
ICON_DIR="$(mktemp -d)/Shengji.iconset"
mkdir -p "$ICON_DIR"
swift native/Icon.swift "$ICON_DIR/icon_512x512@2x.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_DIR/icon_512x512@2x.png" --out "$ICON_DIR/icon_${size}x${size}.png" >/dev/null
  if [[ "$size" != 512 ]]; then
    double=$((size * 2))
    sips -z "$double" "$double" "$ICON_DIR/icon_512x512@2x.png" --out "$ICON_DIR/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$ICON_DIR" -o "$RES_DIR/Shengji.icns"
rm -r "${ICON_DIR:h}"
cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>声迹</string>
<key>CFBundleDisplayName</key><string>声迹</string>
<key>CFBundleIdentifier</key><string>local.shengji.desktop</string>
<key>CFBundleVersion</key><string>6</string>
<key>CFBundleShortVersionString</key><string>0.5.1</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>local.shengji.record</string><key>CFBundleURLSchemes</key><array><string>shengji</string></array></dict></array>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>录音与转写稿</string><key>CFBundleTypeRole</key><string>Viewer</string><key>LSHandlerRank</key><string>Alternate</string><key>CFBundleTypeExtensions</key><array><string>mp3</string><string>m4a</string><string>wav</string><string>txt</string><string>md</string><string>srt</string><string>vtt</string></array></dict></array>
<key>CFBundleExecutable</key><string>Shengji</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>Shengji</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$RES_DIR/node"
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR"
print "已构建：$APP_DIR"
