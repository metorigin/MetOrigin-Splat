#!/bin/bash
# Compile the approved artwork with Apple's macOS enclosure and legacy fallback.
# Normal app builds consume the checked-in outputs; Xcode 26+ is only needed here.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
test "$(uname -s)" = Darwin
mkdir -p target/app-icon-macos
work="$(mktemp -d "$repo_root/target/app-icon-macos/build.XXXXXX")"
source_icon="$work/AppIcon.icon"
compiled="$work/compiled"
mkdir -p "$source_icon/Assets" "$compiled"
cp design/app-icon/macos/icon.json "$source_icon/icon.json"
cp design/app-icon/metorigin-splat-icon-v4.png "$source_icon/Assets/v4.png"
xcrun actool "$source_icon" --compile "$compiled" \
  --platform macosx --minimum-deployment-target 15.0 --app-icon AppIcon \
  --enable-on-demand-resources NO --output-partial-info-plist "$compiled/Info.plist"
test -s "$compiled/Assets.car"
test -s "$compiled/AppIcon.icns"
/usr/bin/iconutil --convert iconset --output "$work/AppIcon.iconset" "$compiled/AppIcon.icns"
output="$repo_root/apps/desktop/src-tauri/icons/macos"
mkdir -p "$output"
cp "$compiled/Assets.car" "$output/Assets.car"
cp "$compiled/AppIcon.icns" "$output/icon.icns"
# actool's legacy ICNS contains 16/32/128/256px renditions; modern high-resolution
# renditions live in Assets.car. Keep the native fallback for tauri dev as well.
cp "$work/AppIcon.iconset/icon_128x128@2x.png" "$output/icon.png"
cp "$work/AppIcon.iconset/icon_16x16@2x.png" "$output/32x32.png"
cp "$work/AppIcon.iconset/icon_128x128.png" "$output/128x128.png"
cp "$work/AppIcon.iconset/icon_128x128@2x.png" "$output/128x128@2x.png"
python3 - "$output" <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import sys

output = Path(sys.argv[1])
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
inputs = ["design/app-icon/macos/icon.json", "design/app-icon/metorigin-splat-icon-v4.png"]
outputs = ["Assets.car", "icon.icns", "icon.png", "32x32.png", "128x128.png", "128x128@2x.png"]
manifest = {
    "schema_version": 1,
    "app_icon_name": "AppIcon",
    "compiler": subprocess.check_output(["xcodebuild", "-version"], text=True).strip(),
    "inputs": {name: digest(Path(name)) for name in inputs},
    "outputs": {name: digest(output / name) for name in outputs},
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY
python3 scripts/macos/verify-app-icon.py
echo "Native macOS icon compiled: $output"
