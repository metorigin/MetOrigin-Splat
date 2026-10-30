#!/usr/bin/env python3
"""Recover omitted crate notices from the exact published Git revision.

Only immutable GitHub raw text URLs derived from checksum-verified crate metadata
are used. No branch/tag guessing and no claim that a declaration is a full text.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from pack_macos import sha256, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cargo-home", type=Path, required=True)
    parser.add_argument("--local-only", action="store_true")
    args = parser.parse_args()
    root = args.evidence.resolve() / "brush"
    audit_path = root / "provenance/audit.json"
    audit = json.loads(audit_path.read_text())
    pending = {i["component"] for i in audit["issues"] if i["kind"] == "license_text_missing"}
    supplied = set()
    for component in audit["components"]:
        if component["id"] not in pending:
            continue
        roots = list((args.cargo_home / "registry/src").glob("*/" + component["id"]))
        if len(roots) != 1:
            continue
        texts = list((roots[0] / "LICENSES").glob("*.txt"))
        basis = "license text contained in checksum-verified crate"
        if not texts and component["license_declared"] == "MPL-2.0":
            texts = list((args.cargo_home / "registry/src").glob("*/indent-0.1.1/LICENSES/MPL-2.0.txt"))
            basis = "standard MPL-2.0 text; package license grant and original copyright notices preserved in manifest and source archive"
        if not texts and "Apache-2.0" in component["license_declared"]:
            texts = sorted((args.cargo_home / "registry/src").glob("*/anyhow-*/LICENSE-APACHE"))[:1]
            basis = "standard Apache-2.0 text; selected from package's declared OR license grant; original source and manifest preserved"
            component["license_selected"] = "Apache-2.0"
        for text in texts:
            target = root / "licenses/cargo" / component["id"] / text.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(text, target)
            component["licenses"].append({"path": str(target.relative_to(root)), "sha256": sha256(target),
                                          "evidence_origin": str(text), "basis": basis})
        if texts:
            supplied.add(component["id"])
    audit["issues"] = [i for i in audit["issues"] if not (i["kind"] == "license_text_missing" and i["component"] in supplied)]
    pending -= supplied
    if args.local_only:
        write_json(audit_path, audit)
        print(json.dumps({"supplied": sorted(supplied), "remaining_issues": audit["issues"]}, indent=2))
        return
    groups = {}
    for component in audit["components"]:
        if component["id"] not in pending:
            continue
        candidates = list((args.cargo_home / "registry/src").glob("*/" + component["id"]))
        if len(candidates) != 1:
            continue
        crate = candidates[0]
        vcs = crate / ".cargo_vcs_info.json"
        if not vcs.is_file():
            continue
        metadata = json.loads(vcs.read_text())
        commit = metadata["git"]["sha1"]
        repository = re.search(r'^(?:repository|homepage) = "https://github.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:/[^\"]*)?"', (crate / "Cargo.toml").read_text(), re.M)
        if not repository or not re.fullmatch(r"[0-9a-f]{40}", commit):
            continue
        repository = repository[1].removesuffix("/").removesuffix(".git")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            continue
        group = groups.setdefault((repository, commit), {"components": [], "paths": {""}})
        group["components"].append(component)
        path = Path(metadata.get("path_in_vcs", ""))
        group["paths"].update(str(p) + "/" for p in [path, *path.parents] if str(p) != ".")
        target = root / "provenance/cargo/vcs" / (component["id"] + ".json")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(vcs, target)
    def fetch(item):
        (repository, commit), group = item
        successful = []
        # Root license usually covers a whole multi-crate workspace. Prefer those
        # exact texts; only search member ancestors if root omitted them too.
        for prefix in sorted(group["paths"], key=len):
            for name in ("LICENSE-MIT", "LICENSE-APACHE", "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"):
                url = f"https://raw.githubusercontent.com/{repository}/{commit}/{prefix}{name}"
                target = root / "licenses/upstream" / repository.replace("/", "_") / commit / (prefix + name)
                if target.is_file():
                    successful.append({"path": str(target.relative_to(root)), "sha256": sha256(target), "url": url})
                    continue
                with tempfile.NamedTemporaryFile() as temporary:
                    result = subprocess.run(["/usr/bin/curl", "--fail", "--location", "--silent", "--show-error",
                        "--connect-timeout", "8", "--max-time", "20", "--output", temporary.name, url], capture_output=True)
                    if result.returncode:
                        continue
                    contents = Path(temporary.name).read_bytes()
                    if not contents or len(contents) > 200000 or b"<html" in contents[:500].lower():
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(contents)
                    successful.append({"path": str(target.relative_to(root)), "sha256": sha256(target), "url": url})
            if successful:
                break
        return group["components"], successful
    recovered = set()
    with ThreadPoolExecutor(max_workers=8) as executor:
        for components, notices in executor.map(fetch, groups.items()):
            if notices:
                for component in components:
                    component["licenses"].extend(notices)
                    recovered.add(component["id"])
                print("recovered", len(components), components[0]["id"], flush=True)
            else:
                print("unavailable", components[0]["id"], flush=True)
    audit["issues"] = [i for i in audit["issues"] if not (i["kind"] == "license_text_missing" and i["component"] in recovered)]
    write_json(audit_path, audit)
    print(json.dumps({"recovered": len(recovered), "remaining_issues": audit["issues"]}, indent=2))


if __name__ == "__main__":
    main()
