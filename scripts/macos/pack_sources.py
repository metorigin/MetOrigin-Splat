#!/usr/bin/env python3
"""Fetch only checksum-pinned upstream source archives from the generated audit.

Nothing is extracted or executed. A downloaded file is accepted only if its full
SHA-256 equals the package recipe. Failures remain explicit in acquisition.json.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tarfile
from urllib.parse import urlparse

from pack_macos import sha256, write_json


def sources_for(component):
    result = list(component.get("sources", []))
    source = component.get("source", {})
    if source.get("sha256") and source.get("url"):
        result.append({"urls": [source["url"]], "sha256": [source["sha256"]]})
    return result


def acquisition_plan(audit, copyleft_only=False):
    planned = {}
    for component in audit["components"]:
        if copyleft_only and not any(token in component["license_declared"] for token in ("GPL", "MPL")):
            continue
        for source in sources_for(component):
            hashes = source.get("sha256", [])
            if len(hashes) != 1 or not re.fullmatch(r"[a-f0-9]{64}", hashes[0]):
                raise ValueError(f"source has no unambiguous SHA-256: {component['id']}")
            digest = hashes[0]
            item = planned.setdefault(digest, {"sha256": digest, "urls": [], "components": []})
            for url in source["urls"]:
                if urlparse(url).scheme not in {"https", "http"}:
                    raise ValueError(f"unsupported source URL: {url}")
                if url not in item["urls"]:
                    item["urls"].append(url)
            if component["id"] not in item["components"]:
                item["components"].append(component["id"])
    return list(planned.values())


def acquire(item, cache):
    output = cache / item["sha256"]
    if output.is_file() and sha256(output) == item["sha256"]:
        return dict(item, status="verified_cached", size_bytes=output.stat().st_size)
    failures = []
    for url in item["urls"]:
        with tempfile.NamedTemporaryFile(prefix="source-", dir=cache, delete=False) as temporary:
            candidate = Path(temporary.name)
        try:
            result = subprocess.run(["/usr/bin/curl", "--fail", "--location", "--silent", "--show-error",
                                     "--connect-timeout", "15", "--max-time", "600", "--output", str(candidate), url],
                                    capture_output=True, text=True, timeout=610)
            if result.returncode:
                failures.append({"url": url, "error": result.stderr.strip()})
                continue
            actual = sha256(candidate)
            if actual != item["sha256"]:
                failures.append({"url": url, "error": "SHA-256 mismatch", "actual_sha256": actual})
                continue
            candidate.replace(output)
            return dict(item, status="verified_download", selected_url=url, size_bytes=output.stat().st_size)
        except subprocess.TimeoutExpired:
            failures.append({"url": url, "error": "download timed out"})
        finally:
            candidate.unlink(missing_ok=True)
    return dict(item, status="unavailable", failures=failures)


def include_sources(audit, cache, engine_root):
    """Copy verified archives into the pack; preserve unresolved source issues."""
    delivered = set()
    for component in audit["components"]:
        sources = sources_for(component)
        complete = bool(sources)
        for source in sources:
            hashes = source.get("sha256", [])
            if len(hashes) != 1:
                complete = False
                continue
            original = cache / hashes[0]
            if not original.is_file() or sha256(original) != hashes[0]:
                complete = False
                continue
            target = engine_root / "provenance/sources" / hashes[0]
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copyfile(original, target)
            source["archive_collected"] = True
            source["archive_path"] = str(target.relative_to(engine_root))
            component.setdefault("source_archives", []).append({"path": str(target.relative_to(engine_root)), "sha256": hashes[0]})
        if complete:
            component["corresponding_source_status"] = "verified_upstream_archives_and_recipe_patches_delivered"
            delivered.add(component["id"])
        # The binary package license covers libgcc broadly, but its actual
        # libquadmath dylib has a separate Library GPL grant. Inspect exact source.
        if complete and component["name"] == "libgcc":
            gcc_sources = [s for s in sources if any("/gcc-" in url for url in s["urls"])]
            if len(gcc_sources) == 1:
                archive_path = cache / gcc_sources[0]["sha256"][0]
                prefix = "gcc-" + component["version"] + "/libquadmath/"
                with tarfile.open(archive_path, "r:*") as archive:
                    grant = archive.extractfile(prefix + "quadmath.h").read()
                    if b"version 2 of the License, or (at your option) any later version" not in grant:
                        raise ValueError("unexpected libquadmath license grant; manual review required")
                    extracted = []
                    for name in ("COPYING.LIB", "quadmath.h"):
                        path = engine_root / "licenses/conda" / component["id"] / "libquadmath" / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(archive.extractfile(prefix + name).read())
                        record = {"path": str(path.relative_to(engine_root)), "sha256": sha256(path),
                                  "source_archive_sha256": gcc_sources[0]["sha256"][0], "archive_member": prefix + name}
                        component["licenses"].append(record)
                        extracted.append(record)
                component["license_effective"] = "GPL-3.0-only WITH GCC-exception-3.1 AND LGPL-2.0-or-later"
                component["file_license_evidence"] = {"lib/libquadmath.0.dylib": {"license": "LGPL-2.0-or-later", "evidence": extracted,
                    "note": "Library-wide grant; individual permissive notices remain in the complete GCC source archive."}}
                audit["issues"] = [i for i in audit["issues"] if i["kind"] != "libquadmath_file_license_needs_source_verification"]
    audit["issues"] = [issue for issue in audit["issues"]
                       if not (issue["kind"] == "corresponding_source_not_delivered" and issue["component"] in delivered)]
    audit["source_archives_delivered_for"] = sorted(delivered)
    audit["limitations"] = [s for s in audit.get("limitations", []) if not s.startswith("No source archives downloaded")]
    audit["limitations"].append("Delivered source archives are checksum-verified upstream inputs plus recorded recipe patches; build reproducibility and combined-license obligations remain separate release checks.")
    audit["corresponding_source_delivered"] = not any(i["kind"] == "corresponding_source_not_delivered" for i in audit["issues"])
    audit["release_ready"] = audit["corresponding_source_delivered"] and not audit["issues"]
    acquisition = cache / "acquisition.json"
    if acquisition.is_file():
        shutil.copyfile(acquisition, engine_root / "provenance/source-acquisition.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audit", type=Path)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--copyleft-only", action="store_true")
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--mirrors", type=Path, help="JSON mapping original SHA-256 to additional public mirror URLs; hashes stay unchanged")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 8:
        parser.error("jobs must be 1..8")
    args.cache.mkdir(parents=True, exist_ok=True)
    plan = acquisition_plan(json.loads(args.audit.read_text()), args.copyleft_only)
    if args.mirrors:
        mirrors = json.loads(args.mirrors.read_text())
        for item in plan:
            for url in mirrors.get(item["sha256"], []):
                if urlparse(url).scheme != "https":
                    raise ValueError("source mirrors must use HTTPS")
                if url not in item["urls"]:
                    item["urls"].append(url)
    records = []
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        for item in executor.map(lambda item: acquire(item, args.cache), plan):
            records.append(item)
            write_json(args.cache / "acquisition.json", {"schema_version": 1, "archives": records})
            print(item["status"], ",".join(item["components"]), flush=True)
    print(json.dumps({"archives": len(records), "verified": sum(r["status"].startswith("verified") for r in records),
                      "unavailable": sum(r["status"] == "unavailable" for r in records)}))


if __name__ == "__main__":
    main()
