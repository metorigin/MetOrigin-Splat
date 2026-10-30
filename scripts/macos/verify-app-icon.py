"""Verify checked-in native icons and, optionally, Tauri's actual bundle wiring."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib


def verify(app=None):
    root = Path(__file__).resolve().parents[2]
    output = root / "apps/desktop/src-tauri/icons/macos"
    manifest = json.loads((output / "manifest.json").read_text())
    inputs = {"design/app-icon/macos/icon.json", "design/app-icon/metorigin-splat-icon-v4.png"}
    outputs = {"Assets.car", "icon.icns", "icon.png", "32x32.png", "128x128.png", "128x128@2x.png"}
    if (manifest.get("schema_version") != 1 or manifest.get("app_icon_name") != "AppIcon"
            or set(manifest.get("inputs", {})) != inputs or set(manifest.get("outputs", {})) != outputs):
        raise ValueError("invalid native icon manifest")
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    for base, records in [(root, manifest["inputs"]), (output, manifest["outputs"])]:
        for name, expected in records.items():
            if digest(base / name) != expected:
                raise ValueError("stale native icon: " + name + "; run bash scripts/macos/build-app-icon.sh")
    if app is not None:
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        if info.get("CFBundleIconName") != "AppIcon" or info.get("CFBundleIconFile") != "icon.icns":
            raise ValueError("application is missing native macOS icon metadata")
        for name in ["Assets.car", "icon.icns"]:
            if digest(app / "Contents/Resources" / name) != manifest["outputs"][name]:
                raise ValueError("application contains a stale native icon: " + name)
    return {"native_macos_icon": "verified", "app_icon_name": "AppIcon", "bundle_checked": app is not None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path)
    print(json.dumps(verify(parser.parse_args().app)))
