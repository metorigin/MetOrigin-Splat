"""Independent, offline consumer of the reviewed 3.10.2 WebP build profile.

The fixed build digest pins its source/archive/toolchain/acceptance semantics;
the complete copied closure is still hashed individually. It never executes a
verifier or profile supplied by the collected evidence. The 3.4.2 verifier is
retained separately with its original source, notice and acceptance checks.
"""
import json
import re

from webp_evidence import (OLD_WASM, OUTPUTS, PREFIX, RUNTIME_COMPONENTS,
                           archive_member, decode_json, digest, indexed,
                           notice_component, read_file, reference, require)

PROFILE = "splat-transform-3.10.2-webp-1.6.0-emscripten-4.0.21-v1"
BUILD_SHA256 = "e78ba0eb4298d07a06116d396893a1e534a9f04118e70d5044eceed74e8e4abb"
FILES_SHA256 = "1462c58696a52e28fc1a38dfd54e5d9ec877b3e2bf416cc0e243ab88963ef23c"
BASE = {"name": "@playcanvas/splat-transform", "version": "3.10.2",
        "commit": "e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8",
        "package_json_sha256": "c65ef9c4e9e84512638391a9b7ca2a2c064dc8a291f80073039174b01e87e1aa"}
UPSTREAM = {"repository": "https://github.com/playcanvas/supersplat.git", "version": "3.7.0",
            "commit": "b89029dd20911fd18905b61de2701094ac390a73"}
COMPONENTS = {**RUNTIME_COMPONENTS, "splat-transform":
              ("pkg:npm/%40playcanvas/splat-transform@3.10.2", "@playcanvas/splat-transform", "3.10.2")}


def selected_current_evidence_files(build):
    require(type(build["schema_version"]) is int and build["schema_version"] == 2
            and build["profile"] == PROFILE, "unsupported current WebP profile")
    records = indexed([reference(item) for item in build["files"]])
    rows = sorted([[path, item["sha256"], item["size_bytes"]] for path, item in records.items()])
    require(len(records) == 87 and digest(json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode()) == FILES_SHA256,
            "current WebP copied evidence differs from the reviewed profile")
    return records


def verify_current_webp_evidence(directory, normalized, manifest, build, build_bytes, identity, components):
    require(digest(build_bytes) == BUILD_SHA256, "unreviewed current WebP build evidence")
    require(manifest["id"] == PROFILE and manifest["base"] == BASE and normalized["base"] == BASE,
            "unexpected current WebP package base")
    selected = selected_current_evidence_files(build)
    recorded = indexed(normalized["files"])
    require(set(recorded) == {PREFIX + path for path in selected}, "copied current evidence inventory mismatch")
    contents = {}
    for path, expected in selected.items():
        require(reference(recorded[PREFIX + path]) == {**expected, "path": PREFIX + path}, "current evidence reference mismatch")
        data = read_file(directory, PREFIX + path)
        require(len(data) == expected["size_bytes"] and digest(data) == expected["sha256"], "current evidence bytes changed: " + path)
        contents[path] = data
    read_record = lambda record: decode_json(contents[record["path"]])
    outputs = indexed(manifest["files"])
    require(set(outputs) == OUTPUTS, "incomplete current derived output set")
    candidate = read_record(build["outputs"]["overlay_candidate"])
    require(candidate["kind"] == "derived-overlay-candidate-3.10.2-v1" and candidate["base"] == BASE, "current candidate identity mismatch")
    candidates = indexed(candidate["files"])
    require(set(candidates) == OUTPUTS, "current candidate output mismatch")
    derived = {}
    for item in build["outputs"]["derived_files"]:
        match = re.fullmatch(r"sources/splat-transform/(.+)", item["file"]["path"])
        require(match and match[1] not in derived, "unexpected current derived output")
        derived[match[1]] = item
    require(set(derived) == OUTPUTS, "incomplete current build output set")
    for path, output in outputs.items():
        require(reference(output) == {**reference(derived[path]["file"]), "path": path}
                and output["base_sha256"] == derived[path]["original_sha256"], "current derived output binding mismatch")
        require(all(output[key] == candidates[path][key] for key in
                    ("sha256", "size_bytes", "base_sha256", "compressed_sha256", "payload")), "current candidate payload binding mismatch")
    require(normalized["historical_prebuilt"] == {"wasm_sha256": OLD_WASM, "status": "provenance-unresolved"},
            "historical provenance rewritten")
    runtime = build["runtime_evidence"]
    linked = sorted(map(archive_member, runtime["linked_members"]))
    require(normalized["runtime"] == {"linked_members": linked, "sources": build["sources"]}, "current normalized runtime mismatch")
    originals = indexed(runtime["original_notices_and_linked_sources"])
    expected_notices = {PREFIX + path: (item, notice_component(path)) for path, item in originals.items() if notice_component(path)}
    notices = indexed(normalized["notices"])
    require(set(notices) == set(expected_notices), "current runtime notices incomplete")
    license_index = decode_json(read_file(directory, "dependency-license-index.json"))
    for ref, name, version in COMPONENTS.values():
        require(ref in components and (components[ref].get("name"), components[ref].get("version")) == (name, version),
                "missing/mislabeled current runtime component: " + name)
    props = {item["name"]: item["value"] for item in components[COMPONENTS["splat-transform"][0]].get("properties", [])}
    require(props.get("metorigin:distribution-kind") == "derived-fixed-webp-overlay"
            and props.get("metorigin:webp-overlay-id") == identity["id"]
            and props.get("metorigin:webp-overlay-manifest-sha256") == identity["manifest_sha256"], "current derivative mislabeled as original")
    wasm_ref = "webp-wasm:sha256:" + outputs["lib/webp.wasm"]["sha256"]
    require(wasm_ref in components and {"alg": "SHA-256", "content": outputs["lib/webp.wasm"]["sha256"]}
            in components[wasm_ref].get("hashes", []), "current WASM component binding missing")
    for path, (original, owner) in expected_notices.items():
        notice = notices[path]
        require(reference(notice) == {**reference(original), "path": path} and notice["runtime_component"] == owner
                and notice["component"] == COMPONENTS[owner][0], "current notice ownership/binding mismatch")
        require(any(item.get("component") == notice["component"] and all(item.get(key) == notice[key] for key in
                    ("path", "sha256", "size_bytes")) for item in license_index), "current notice absent from license index")
        if owner == "libwebp":
            require(any(item.get("component") == COMPONENTS["sharpyuv"][0] and all(item.get(key) == notice[key] for key in
                        ("path", "sha256", "size_bytes")) for item in license_index), "shared current sharpyuv notice missing")
    built = decode_json(read_file(directory, "supersplat/build.json"))
    require(all(built.get(key) == value for key, value in UPSTREAM.items()), "prepared current editor source mismatch")
    require(built["webp_overlay"] == identity and isinstance(built["signature"], str)
            and re.fullmatch(r"[a-f0-9]{64}", built["signature"]), "prepared current frontend identity mismatch")
    assets = indexed(built["assets"])
    static = indexed(decode_json(read_file(directory, "supersplat/static-payload-inventory.json")))
    for name in ("webp.wasm", "webp.mjs"):
        path = "static/lib/webp/" + name
        if name == "webp.mjs" and path not in assets and path not in static:
            continue  # 3.7 imports the paired glue from its bundled npm module.
        require(path in assets and path in static and all(assets[path][key] == static[path][key] == outputs["lib/" + name][key]
                    for key in ("sha256", "size_bytes")), "prepared current codec inventory mismatch")
    source_map = decode_json(read_file(directory, "supersplat/source-map-package-evidence.json"))
    require(source_map["upstream"] == UPSTREAM and source_map["webp_overlay"] == identity
            and source_map["source_map_sha256"] == assets["index.js.map"]["sha256"], "current source-map inventory mismatch")
    require(source_map["derived_module"] == {"source": "../node_modules/@playcanvas/splat-transform/dist/index.mjs",
            "sha256": outputs["dist/index.mjs"]["sha256"], "base": BASE}
            and "node_modules/@playcanvas/splat-transform" in source_map["packages"], "current source-map derivative mismatch")
    index = decode_json(read_file(directory, "build-inputs/app-vendored-evidence.json"))
    require(index["current_supersplat"]["upstream"] == UPSTREAM and index["current_supersplat"]["transform"] ==
            {key: BASE[key] for key in ("name", "version", "commit")}
            and index["current_supersplat"]["overlay_directory"] == "webp-overlay-3.10.2"
            and index["webp"]["wasm_sha256"] == OLD_WASM, "current/historical vendored binding mismatch")
    return {"status": "verified-derived-replacement", "profile": PROFILE, "overlay": identity,
            "evidence_file_count": len(selected), "runtime_notice_count": len(notices), "linked_member_count": len(linked),
            "historical_prebuilt_provenance": "unresolved", "scope": "Fixed reviewed source/build/notice closure; actual frontend inputs and final binary require their independent receipts."}
