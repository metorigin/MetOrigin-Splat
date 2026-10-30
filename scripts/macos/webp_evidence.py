"""Independent offline checks for the collected, derived WebP license evidence.

This checks recorded build/notice relationships, not a source rebuild or a
symbol-level binary SBOM. Final frontend and application binding are separate.
"""
import hashlib
import json
from pathlib import Path
import re
import stat


FINDING = "supersplat-webp-provenance"
PREFIX = "vendored/webp/evidence/"
OLD_WASM = "e2c337e1afacf5c9e35f21916b5615fc6c5623074c6e110c07791bd0af071501"
EMSCRIPTEN = "d6f42310010ddec0753a69bab01a4b33aae255b7"
RUNTIME_SOURCE = "sources/emsdk/upstream/emscripten/"
PINS = {
    "libwebp": ("1.6.0", "4fa21912338357f89e4fd51cf2368325b59e9bd9", "webmproject/libwebp", "923f3382a47a2af185c3240c954cf004428b237bd7317413a95146d01eb4b94b"),
    "emsdk": ("4.0.21", "b2436aafa7351ee1b581f15841f1b45ed716a279", "emscripten-core/emsdk", "0279973682a9830976256cd5b28692c4ea7931f2a47baf2d0b3e22e31b6d3741"),
    "splat-transform": ("3.4.2", "0cb47cd81023cca117c20ce59a55ba584ee89177", "playcanvas/splat-transform", "a8753ef7c53f7138f6552c4b81e8f4703060aecda0b93d2b807a4602e4d1c0d6"),
    "sharpyuv": ("0.4.2", "4fa21912338357f89e4fd51cf2368325b59e9bd9", None, None),
}
BASE = {"name": "@playcanvas/splat-transform", "version": "3.4.2", "commit": PINS["splat-transform"][1],
        "package_json_sha256": "b9d3e4010066c175d09435a0935e30a3f62d6fc9136697c8ada5933c09a95e55"}
OUTPUTS = {"lib/webp.mjs", "lib/webp.wasm", "dist/index.mjs", "dist/index.mjs.map",
           "dist/index.cjs", "dist/index.cjs.map", "dist/worker.mjs", "dist/worker.mjs.map",
           "dist/cli.mjs", "dist/cli.mjs.map"}
SOURCE_BEFORE = "1cfb3c675343af986f57eae3b66b1763008548eb2364dd6972a352958c2ed225"
SOURCE_AFTER = "93b36f2b4ce70c2980b321ff2c947ae84ed019e0fade3ced9a2d3bc7d7b2f594"
COUNTS = {"primary_cases": 22, "recovery_cases": 44, "successful_output_comparisons": 5, "failed_case_groups": 0}
RUNTIME_COMPONENTS = {
    "splat-transform": ("pkg:npm/%40playcanvas/splat-transform@3.4.2", "@playcanvas/splat-transform", "3.4.2"),
    "libwebp": ("pkg:generic/libwebp@1.6.0", "libwebp", "1.6.0"),
    "sharpyuv": ("pkg:generic/sharpyuv@0.4.2", "sharpyuv", "0.4.2"),
    "emscripten-runtime": ("pkg:generic/emscripten-runtime@4.0.21", "emscripten-runtime", "4.0.21"),
    **{name: (f"pkg:generic/{name}@emscripten-d6f4231", name, "emscripten-d6f4231") for name in ("musl", "dlmalloc", "compiler-rt")},
}
# Original upstream text, independently pinned so replacing a grant while
# regenerating the enclosing JSON inventories cannot silently clear the finding.
NOTICE_PINS = {
    'licenses/libwebp/COPYING': '5aec868f669e384a22372a4e8a1a6cd7d44c64cd451f960ca69cc170d1e13acf',
    'licenses/libwebp/PATENTS': 'cc3273e0694ea5896145e0677699b53471b03ea43021ddc50e7923fbb9f5023c',
    'licenses/libwebp/AUTHORS': 'f251be89fd442bd9d701360730aea163cc8e2076ff03528f59267dc2c4f8b60a',
    'licenses/splat-transform/LICENSE': '42fa51ddd556be151a29f381fb97ee975825dcc454e805ea3ea9c079cca04d34',
    'licenses/emscripten/LICENSE': '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
    'licenses/emscripten/AUTHORS': '8585fa1b981f576f52806833481323007ccac5c00f31a873215e31c0f42820f0',
    'licenses/emscripten/system/lib/libc/musl/COPYRIGHT': 'f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af',
    'licenses/emscripten/system/lib/compiler-rt/LICENSE.TXT': '1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d',
    'licenses/emscripten/system/lib/libc/musl/src/errno/__errno_location.c': '167fe0721c519c40c6d674db4a3a7c042e54140be230b876024e999660424878',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_divzero.c': '84aa910bdc5e7ccfed42098c37c44e278aa942d46e5a51d5ee8273336c79e719',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_divzerof.c': '194c95f6cd238ffa14e78087b9acffca3a064f2fe46320d67b090bb7a559b1ca',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_invalid.c': 'b56440ed59fa1e1aaaf6bf8b672c8bb71eaf844457906f7773da1d67d7ef013b',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_invalidf.c': 'd2af8360271109d77dfab3c538eb158e34633454707dea4efa9f2f1e7e2bd0c7',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_oflow.c': '74669de53bc4b250183cfa262a8a03ee8106f33a83e3aca6b217bafc7363b83c',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_oflowf.c': '69414934bb798f5261e2d80f4b878e2bbe4dfa6025adbd06586195ba5554b04a',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_uflow.c': '9a841197bbe9ade9bbd684f8bc65424a97c481d37dabb9fa1790bafe7959034a',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_uflowf.c': '2371ed08fc95e48833a67122b5ef538ce7fc87f40fc7a4df451d71e1787d1d42',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_xflow.c': '5feafe10347636884a071a5096f912d5ca4a0939844804ca09b88241405648ad',
    'licenses/emscripten/system/lib/libc/musl/src/math/__math_xflowf.c': '38da031cfed0ba90e68a14dfbc57404ebcb827c9ac34648161c7d11cb212c9ba',
    'licenses/emscripten/system/lib/libc/emscripten_get_heap_size.c': 'f642e9c8e89121b3c379535996cb78d8a7fa0626ef8351d7b00c1824dcdb1dbe',
    'licenses/emscripten/system/lib/libc/emscripten_memcpy.c': '1eed22a14ee2143283ad19a0494355734bd9d48a19b318b605c86f274642afa0',
    'licenses/emscripten/system/lib/libc/emscripten_memcpy_bulkmem.S': '39af87c7ef0479fa2c4863838b4012a8ed86e89d6e37035c1054666731ffc016',
    'licenses/emscripten/system/lib/libc/emscripten_memset.c': '7f345bf7ffbb49e3d7e1691538a243471e67e0e11c9e06b518c2b691295b1cdf',
    'licenses/emscripten/system/lib/libc/musl/src/math/exp2f_data.c': '3da38c471cc5eb8dc1c2e283c6c00a36b1d353ba5c8ca1e82d95180948e26bd5',
    'licenses/emscripten/system/lib/libc/musl/src/math/exp2f_data.h': 'fb52b690bef63df2e8996f2d2b3fd77f9ea08795863e73afdc882df04460e850',
    'licenses/emscripten/system/lib/libc/musl/src/math/exp_data.c': 'c55dff64e369fe816cd8ce367064989bb119f85783599680d1a329031c660689',
    'licenses/emscripten/system/lib/libc/musl/src/math/exp_data.h': 'df77fca837edd02b260dd09a2914202775909ae67a059218ae38cfab104e6d16',
    'licenses/emscripten/system/lib/libc/musl/src/math/expf.c': '225123b9b3a47a083c06f2580c6b73d5cadae5cec545f9e928f7041ff837b4b4',
    'licenses/emscripten/system/lib/libc/musl/src/math/fabs.c': 'f6387612e1f879cac47fa71a808b584c76d78c23df4e44274ed9c7b1ddf24eff',
    'licenses/emscripten/system/lib/libc/musl/src/math/log.c': 'a0694d8587a0d145d0f8ae87cbffba014d7988bc2ebcbfad94cea73b394c9ecc',
    'licenses/emscripten/system/lib/libc/musl/src/math/log10.c': 'ef9b4b1f0918cf1fcb797f9fa4d4ffe177bfa27f668d74a41d613bfbcd83850a',
    'licenses/emscripten/system/lib/libc/musl/src/math/log_data.c': 'e96bcd99d88fc57e0f3686299014f4b949a6212603ce237f39e16cedc155617a',
    'licenses/emscripten/system/lib/libc/musl/src/math/log_data.h': 'a8dced6f0821f30cad040ba326b03e419fbe0a750ed8f3b0d7145992bee4bccc',
    'licenses/emscripten/system/lib/libc/musl/src/math/logf.c': 'eecf8e5dd0afd5f64f938ccae07c85b0a8e82919f5d4269936a3b8493fb64e47',
    'licenses/emscripten/system/lib/libc/musl/src/math/logf_data.c': '60b08342fcef877b393a76fc36d92c576d6340ce153459aad03aad3d4716f9b5',
    'licenses/emscripten/system/lib/libc/musl/src/math/logf_data.h': '80176d1f045f162e917ca5c2879994ab0ed9e27b479086d752e5793c91135adf',
    'licenses/emscripten/system/lib/libc/musl/src/string/memcmp.c': '2514492fc7e9249713857dfd12c1a3630661aa163f16bc40a6f59f8cd8e76aeb',
    'licenses/emscripten/system/lib/libc/musl/src/math/pow.c': 'b06f0a08d74fcff8cced7afa2c0e47e301e3e8a19c0de5becdec28cd7b014027',
    'licenses/emscripten/system/lib/libc/musl/src/math/pow_data.c': '2052ec913f9b4a2170a98a6fcbcd7694f5dec220036b00c36106a2b4b65a4c55',
    'licenses/emscripten/system/lib/libc/musl/src/math/pow_data.h': '5014345a7958adcf6ff835b5e96afa99dd5a98c40dfe968442288e002b8e01a3',
    'licenses/emscripten/system/lib/libc/musl/src/stdlib/qsort.c': '3a838cc7f83f4746df6063f567be1ebb2f7d204243342122acd43f44d2434ec6',
    'licenses/emscripten/system/lib/libc/musl/src/stdlib/qsort_nr.c': 'ba6ce7460e7b4b22d70c8d7acab2bdb5d3916f428d50b42bb29e4da5eec484d9',
    'licenses/emscripten/system/lib/compiler-rt/stack_ops.S': 'f99c53c18be77b978f2255c5ef9c1c31798fe17dea87ca87f34ae39a2f237045',
    'licenses/emscripten/system/lib/dlmalloc.c': 'c008dc3c2b005ba822efb1bf6187a9d7a6aecd096826c6f28c6f5ee62885053d',
    'licenses/emscripten/system/lib/libc/sbrk.c': '7a348606c92e9e5311ed307bbfba0b4a6a56692ff4005d440cb3a9e983fed7c9',
    'licenses/emscripten/system/lib/libc/musl/src/internal/libm.h': '8cb6cc4af4b96b92f5af9d4e20609c8b8456bded8908c3d58f5b8e8f37620f67',
    'licenses/emscripten/system/lib/libc/musl/src/internal/atomic.h': '7564773807b69ceeb5542882ab20e92253ded8289d8944eafe7208903aaa2e18',
    'licenses/emscripten/system/lib/libc/musl/src/internal/pthread_impl.h': '9c0917012766522e7465195774c7ea766366e567a64f62df9535b1ae7d60b07d',
}


def require(condition, message):
    if not condition:
        raise ValueError("WebP evidence: " + message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(value):
    require(isinstance(value, str) and 0 < len(value) < 512
            and all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) and part not in (".", "..") for part in value.split("/")),
            "unsafe evidence path")
    return value


def reference(record):
    require(isinstance(record, dict) and isinstance(record.get("sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", record["sha256"])
            and type(record.get("size_bytes")) is int and 0 <= record["size_bytes"] <= 16 * 1024 * 1024,
            "malformed evidence file reference")
    return {"path": safe_path(record["path"]), "sha256": record["sha256"], "size_bytes": record["size_bytes"]}


def read_file(root, name, limit=16 * 1024 * 1024):
    path = root
    parts = safe_path(name).split("/")
    for index, part in enumerate(parts):
        path = path / part
        mode = path.lstat().st_mode
        require(not stat.S_ISLNK(mode) and (stat.S_ISREG(mode) if index == len(parts) - 1 else stat.S_ISDIR(mode)),
                "nonphysical file: " + name)
    require(path.stat().st_size <= limit, "oversized file: " + name)
    return path.read_bytes()


def decode_json(data):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique_pairs)


def indexed(items, key="path"):
    require(isinstance(items, list), "expected list")
    result = {}
    for item in items:
        require(isinstance(item, dict) and key in item and isinstance(item[key], str) and item[key] not in result,
                "duplicate or missing " + key)
        result[item[key]] = item
    return result


def archive_member(value):
    require(isinstance(value, str), "malformed archive member")
    match = re.search(r"(?:^|/)(lib(?:c|dlmalloc|compiler_rt|webp|sharpyuv)\.a\([^()/]+\))$", value)
    require(match is not None, "unknown linked runtime archive")
    return match[1]


def notice_component(path):
    if path.startswith("licenses/libwebp/"):
        return "libwebp"
    if path == "licenses/splat-transform/LICENSE":
        return "splat-transform"
    if path.startswith("licenses/emscripten/system/lib/libc/musl/"):
        return "musl"
    if path.startswith("licenses/emscripten/system/lib/compiler-rt/"):
        return "compiler-rt"
    if path == "licenses/emscripten/system/lib/dlmalloc.c":
        return "dlmalloc"
    if path.startswith("licenses/emscripten/") and not path.startswith("licenses/emscripten/tools/"):
        return "emscripten-runtime"
    return None


def selected_evidence_files(evidence):
    """Recompute the copied subset without trusting its normalized inventory."""
    if evidence.get("schema_version") == 2:
        from webp_evidence_3102 import selected_current_evidence_files
        return selected_current_evidence_files(evidence)
    require(type(evidence["schema_version"]) is int and evidence["schema_version"] == 1, "unsupported build evidence")
    first = next((step for step in evidence["successful_steps"] if step["path"] == "receipts/install-sdk.json"), None)
    require(first and first["command"]["cwd"].endswith("/sources/emsdk"), "missing SDK stage identity")
    stage = first["command"]["cwd"][:-len("/sources/emsdk")]
    result = {}

    def collect(value):
        if isinstance(value, list):
            for child in value:
                collect(child)
        elif isinstance(value, dict):
            if {"path", "sha256", "size_bytes"}.issubset(value):
                path = value["path"]
                require(isinstance(path, str), "malformed evidence path")
                if path.startswith("${REPO_ROOT}/"):
                    normalization = evidence.get("path_normalization", {})
                    require(normalization.get("schema_version") == 1
                            and normalization.get("original_build_evidence_sha256") ==
                            "d5b9bb0d38bb3f611656455a2853651469e5ed1f5c02cae965396630c873ecaa",
                            "unreviewed normalized evidence path")
                if path.startswith(("/", "${REPO_ROOT}/")):
                    require(path.startswith(stage + "/"), "absolute log escapes stage")
                    path = path[len(stage) + 1:]
                    require(re.match(r"^(?:v2/)?logs/", path), "absolute non-log reference")
                record = reference({**value, "path": path})
                require(path not in result or result[path] == record, "conflicting evidence reference")
                result[path] = record
            for key, child in value.items():
                if key not in ("path", "source_path"):
                    collect(child)

    for source in evidence["sources"]:
        collect(source.get("wrapper"))
        collect(source.get("version_header"))
    for key in ("environment", "emsdk_config", "cmake_cache", "source_changes", "build_driver", "codec_source_change", "dependency_clone", "rebuild_recipe"):
        collect(evidence["configuration"].get(key))
    collect(evidence["successful_steps"])
    collect(evidence["recorded_non_success_attempts"])
    for key in ("link_map", "symbol_map", "overlay_candidate"):
        collect(evidence["outputs"][key])
    collect(evidence["runtime_evidence"]["original_notices_and_linked_sources"])
    collect(evidence["verification"])
    return result


def _verify(directory, readiness):
    normalized_path = "vendored/webp/evidence.json"
    normalized_exists = (directory / normalized_path).exists()
    bom = decode_json(read_file(directory, "SBOM.cdx.json"))
    components = indexed(bom.get("components", []), "bom-ref")
    resolutions = [item for item in readiness.get("resolved_findings", []) if item.get("id") == FINDING]
    issues = [item for item in readiness.get("issues", []) if item.get("id") == FINDING]
    require(len(resolutions) <= 1 and len(issues) <= 1, "duplicate provenance finding")
    has_webp = any(re.search(r"supersplat|splat-transform|webp", json.dumps(item), re.I) for item in components.values())
    has_webp = has_webp or (directory / "supersplat").exists() or (directory / "vendored/webp").exists()
    if not normalized_exists:
        derived_marker = (directory / "vendored/webp").exists() or (directory / "vendored/webp").is_symlink()
        derived_marker = derived_marker or any(prop.get("name", "").startswith("metorigin:webp-overlay")
                or (prop.get("name") == "metorigin:distribution-kind" and prop.get("value") == "derived-fixed-webp-overlay")
                or (prop.get("name") in ("metorigin:runtime-evidence", "metorigin:build-evidence")
                    and str(prop.get("value", "")).startswith("vendored/webp/"))
                for item in components.values() for prop in item.get("properties", []))
        derived_marker = derived_marker or any(ref.startswith("webp-wasm:sha256:") and ref != "webp-wasm:sha256:" + OLD_WASM for ref in components)
        build_path = directory / "supersplat/build.json"
        if build_path.exists() or build_path.is_symlink():
            historical_build = decode_json(read_file(directory, "supersplat/build.json"))
            derived_marker = derived_marker or "webp_overlay" in historical_build
        require(not derived_marker, "incomplete derived proof cannot downgrade to historical evidence")
        require(not resolutions, "resolved provenance has no derived proof")
        require(not has_webp or bool(issues), "WebP provenance issue removed without derived proof")
        return None
    require(not issues and len(resolutions) == 1, "derived proof requires its resolved finding")
    require(resolutions[0].get("evidence") == normalized_path and resolutions[0].get("resolution") == "replaced-with-fixed-source-build",
            "invalid replacement resolution")
    normalized = decode_json(read_file(directory, normalized_path))
    require(type(normalized["schema_version"]) is int and normalized["schema_version"] == 1
            and normalized["status"] == "verified-derived-replacement", "unsupported derived proof")
    manifest_bytes = read_file(directory, "vendored/webp/manifest.json", 128 * 1024)
    build_bytes = read_file(directory, "vendored/webp/build-evidence.json", 4 * 1024 * 1024)
    manifest, build = decode_json(manifest_bytes), decode_json(build_bytes)
    identity = {"id": manifest["id"], "manifest_sha256": digest(manifest_bytes), "build_evidence_sha256": digest(build_bytes)}
    require(type(manifest["schema_version"]) is int and manifest["schema_version"] == 1
            and isinstance(manifest["id"], str) and manifest["id"], "invalid overlay identity")
    require(normalized["overlay"] == identity and manifest["build_evidence_sha256"] == identity["build_evidence_sha256"], "overlay identity mismatch")
    if build.get("schema_version") == 2:
        from webp_evidence_3102 import verify_current_webp_evidence
        return verify_current_webp_evidence(directory, normalized, manifest, build, build_bytes, identity, components)
    require(manifest["base"] == BASE and normalized["base"] == BASE, "unexpected package base")
    require(normalized["historical_prebuilt"]["wasm_sha256"] == OLD_WASM
            and normalized["historical_prebuilt"]["status"] == "provenance-unresolved", "historical provenance rewritten")
    sources = indexed(build["sources"], "name")
    require(set(sources) == set(PINS), "unexpected source inventory")
    for name, (version, commit, repository, archive_sha) in PINS.items():
        source = sources[name]
        require((source["version"], source["commit"]) == (version, commit), "unpinned source: " + name)
        if repository:
            require(source["repository"] == "https://github.com/" + repository
                    and source["download_url"] == f"https://codeload.github.com/{repository}/tar.gz/{commit}"
                    and source["archive"]["sha256"] == archive_sha, "source archive mismatch: " + name)
    require(sources["splat-transform"]["wrapper"]["sha256"] == "32c66c6de02eb30223d629987dfbe885e9f2039a663fe3f9eebd666c0b4d62f9"
            and sources["sharpyuv"]["version_header"]["sha256"] == "4fcb150246232b0e8e605752deb66ca861872f86dd692308d9f854e10ad964ee", "wrapper/header identity mismatch")
    toolchain = build["toolchain"]
    require(toolchain["emscripten_version"] == "4.0.21" and toolchain["emscripten_commit"] == EMSCRIPTEN
            and toolchain["release_selector"] == "d70a5da89b3e673bf6a482724478fc17e81e575e", "toolchain identity mismatch")
    sdk = [item for item in toolchain["archives"] if item["path"].endswith("-wasm-binaries-arm64.tar.xz")]
    require(len(sdk) == 1 and sdk[0]["sha256"] == "7960d8d33243f2f7acdac157136c6e93680550361ed71bb225fcfa25b6bbb2fb"
            and sdk[0]["download_url"] == f"https://storage.googleapis.com/webassembly/emscripten-releases-builds/mac/{toolchain['release_selector']}/wasm-binaries-arm64.tar.xz", "SDK archive mismatch")
    emcc = toolchain["actual_versions"]["emcc"]
    require(emcc["exit_code"] == 0 and f"4.0.21 ({EMSCRIPTEN})" in emcc["stdout"], "compiler receipt mismatch")
    config = build["configuration"]
    require(config["allocator"] == "dlmalloc" and config["simd"] is False and config["threads"] is False, "runtime configuration mismatch")
    selected = selected_evidence_files(build)
    recorded = indexed(normalized["files"])
    require(set(recorded) == {PREFIX + path for path in selected}, "copied evidence inventory mismatch")
    contents = {}
    for path, ref in selected.items():
        require(reference(recorded[PREFIX + path]) == {**ref, "path": PREFIX + path}, "normalized file binding mismatch")
        contents[path] = read_file(directory, PREFIX + path)
        require(len(contents[path]) == ref["size_bytes"] and digest(contents[path]) == ref["sha256"], "file hash/size mismatch: " + path)
    read_record = lambda ref: decode_json(contents[ref["path"]])
    outputs = indexed(manifest["files"])
    require(set(outputs) == OUTPUTS, "incomplete derived output set")
    derived = {}
    for item in build["outputs"]["derived_files"]:
        match = re.fullmatch(r"sources/splat-transform(?:-v2)?/(.+)", item["file"]["path"])
        require(match and match[1] not in derived, "duplicate/unexpected derived output")
        derived[match[1]] = item
    require(set(derived) == OUTPUTS, "incomplete build output set")
    candidate = read_record(build["outputs"]["overlay_candidate"])
    require(candidate["kind"] == "derived-overlay-candidate-v2" and candidate["base"] == BASE, "candidate identity mismatch")
    candidates = indexed(candidate["files"])
    require(set(candidates) == OUTPUTS, "candidate output mismatch")
    for path, output in outputs.items():
        require(reference(output) == {**reference(derived[path]["file"]), "path": path}
                and output["base_sha256"] == derived[path]["original_sha256"], "derived output binding mismatch")
        require(all(output[key] == candidates[path][key] for key in ("sha256", "size_bytes", "base_sha256", "compressed_sha256")), "candidate payload binding mismatch")
    paired = indexed(build["outputs"]["paired_codec"])
    require(set(paired) == {"outputs/webp.mjs", "outputs/webp.wasm"}, "missing paired codec")
    for name in ("webp.mjs", "webp.wasm"):
        require(all(paired["outputs/" + name][key] == outputs["lib/" + name][key] for key in ("sha256", "size_bytes")), "paired codec mismatch")
    steps = indexed(build["successful_steps"])
    for path, step in steps.items():
        require(step["command"]["exit_code"] == 0 and read_record(step) == step["command"], "unsuccessful/inconsistent build command")
    require({"emcc", "-sMODULARIZE=1", "-sEXPORT_ES6=1"}.issubset(steps["receipts/link-webp.json"]["command"]["argv"]), "missing codec link recipe")
    runtime = build["runtime_evidence"]
    linked = [archive_member(value) for value in runtime["linked_members"]]
    require(len(linked) == len(set(linked)), "duplicate linked member")
    mapped_members = {archive_member(value) for value in re.findall(r"[^\s]+\.a\([^()]+\)", contents[build["outputs"]["link_map"]["path"]].decode())}
    require(set(linked) == mapped_members and len(linked) == 94, "runtime differs from actual link map")
    require(normalized["runtime"]["linked_members"] == sorted(linked) and normalized["runtime"]["sources"] == build["sources"], "normalized runtime mismatch")
    selected_runtime = {value for value in linked if re.match(r"lib(?:c|dlmalloc|compiler_rt)\.a\(", value)}
    mappings = {archive_member(item["archive_member"]): item for item in runtime["source_mapping"]}
    require(len(mappings) == len(runtime["source_mapping"]) and set(mappings) == selected_runtime
            and {"libdlmalloc.a(dlmalloc.o)", "libcompiler_rt.a(stack_ops.o)"}.issubset(selected_runtime), "runtime source coverage mismatch")
    mapping_identity = sorted([[archive_member(item["archive_member"]), sorted(item["source_paths"])] for item in runtime["source_mapping"]])
    require(digest(json.dumps(mapping_identity, separators=(",", ":")).encode()) == "847a4dc24bb696ffaecd1d79bc634e134095481a4820195b93af113e9a2f9fb6",
            "runtime source mapping differs from fixed source evidence")
    originals = indexed(runtime["original_notices_and_linked_sources"])
    for path, expected_sha in NOTICE_PINS.items():
        require(path in originals and originals[path]["sha256"] == expected_sha, "missing/changed original runtime notice: " + path)
    require({path for path in originals if notice_component(path)} == set(NOTICE_PINS), "unexpected runtime notice/source set")
    for path, original in originals.items():
        if path.startswith("licenses/emscripten/"):
            require(original["source_path"] == RUNTIME_SOURCE + path[len("licenses/emscripten/"):]
                    and original["origin"] == "Emscripten " + EMSCRIPTEN, "runtime original source attribution mismatch")
        elif path.startswith("licenses/libwebp/"):
            require(original["source_path"] == "sources/" + path[len("licenses/"):]
                    and original["origin"] == "libwebp commit " + PINS["libwebp"][1], "libwebp original source attribution mismatch")
        elif path == "licenses/splat-transform/LICENSE":
            require(original["source_path"] == "sources/splat-transform/LICENSE"
                    and original["origin"] == "splat-transform commit " + PINS["splat-transform"][1], "wrapper original source attribution mismatch")
    original_sources = indexed(list(originals.values()), "source_path")
    for member, mapping in mappings.items():
        stem = member.split("(")[1][:-3]
        require(mapping["source_paths"] and any(Path(path).stem == stem for path in mapping["source_paths"]), "runtime source name mismatch")
        for source in mapping["source_paths"]:
            require(source.startswith(RUNTIME_SOURCE) and source in original_sources
                    and original_sources[source]["origin"] == "Emscripten " + EMSCRIPTEN, "missing linked source original notice")
    expected_notices = {PREFIX + path: (record, notice_component(path)) for path, record in originals.items() if notice_component(path)}
    notices = indexed(normalized["notices"])
    require(set(notices) == set(expected_notices), "normalized runtime notices incomplete")
    license_index = decode_json(read_file(directory, "dependency-license-index.json"))
    for ref, name, version in RUNTIME_COMPONENTS.values():
        require(ref in components and components[ref].get("name") == name and components[ref].get("version") == version,
                "missing/mislabeled runtime component: " + name)
    derived_component = components[RUNTIME_COMPONENTS["splat-transform"][0]]
    properties = {item["name"]: item["value"] for item in derived_component.get("properties", [])}
    require(properties.get("metorigin:distribution-kind") == "derived-fixed-webp-overlay"
            and properties.get("metorigin:webp-overlay-id") == identity["id"]
            and properties.get("metorigin:webp-overlay-manifest-sha256") == identity["manifest_sha256"], "derived npm package labeled as original bytes")
    wasm_ref = "webp-wasm:sha256:" + outputs["lib/webp.wasm"]["sha256"]
    require(wasm_ref in components and {"alg": "SHA-256", "content": outputs["lib/webp.wasm"]["sha256"]}
            in components[wasm_ref].get("hashes", []), "WASM component binding missing")
    for path, (original, runtime_component) in expected_notices.items():
        notice = notices[path]
        require(reference(notice) == {**reference(original), "path": path} and notice["runtime_component"] == runtime_component
                and notice["component"] == RUNTIME_COMPONENTS[runtime_component][0], "notice ownership/binding mismatch")
        require(any(item.get("component") == notice["component"] and all(item.get(key) == notice[key] for key in ("path", "sha256", "size_bytes")) for item in license_index), "notice absent from dependency license index")
    sharpyuv = [ref for ref, item in components.items() if "sharpyuv" in item.get("name", "").lower() and item.get("version") == "0.4.2"]
    require(len(sharpyuv) == 1, "missing sharpyuv runtime component")
    for path in ("licenses/libwebp/COPYING", "licenses/libwebp/PATENTS", "licenses/libwebp/AUTHORS"):
        require(any(item.get("component") == sharpyuv[0] and item.get("path") == PREFIX + path
                    and item.get("sha256") == originals[path]["sha256"] for item in license_index), "shared sharpyuv notice missing")
    changes = config["codec_source_change"]
    require(changes["original"]["sha256"] == SOURCE_BEFORE and changes["modified"]["sha256"] == SOURCE_AFTER, "cleanup source mismatch")
    patch = read_record(changes["patch_record"])
    require(patch["original_sha256"] == SOURCE_BEFORE and patch["modified_sha256"] == SOURCE_AFTER
            and any(item["sha256"] == patch["patch_sha256"] for item in config["source_changes"]), "cleanup patch mismatch")
    verification = build["verification"]
    for key in ("codec", "distributions"):
        require(read_record(verification[key])["status"].startswith("passed"), "failed codec/distribution acceptance")
    upstream = verification["upstream_sog_html_webp_tests"]
    require((upstream["tests"], upstream["passed"], upstream["failed"]) == (18, 18, 0), "upstream tests incomplete")
    cleanup = read_record(verification["cleanup"])
    require(cleanup["status"] == "passed" and cleanup["counts"] == COUNTS and verification["cleanup_counts"] == COUNTS,
            "cleanup acceptance incomplete")
    require(len(cleanup["cases"]) == 22 and sum(len(item["recovery"]) for item in cleanup["cases"]) == 44
            and len(cleanup["success_path_comparison"]) == 5, "cleanup case inventory mismatch")
    for key, expected_sha in (("v1_source", SOURCE_BEFORE), ("v2_source", SOURCE_AFTER),
                              ("glue", outputs["lib/webp.mjs"]["sha256"]), ("wasm", outputs["lib/webp.wasm"]["sha256"])):
        require(cleanup["bindings"][key]["sha256"] == expected_sha, "cleanup tested different inputs")
    for case in cleanup["cases"]:
        for result in [case] + case["recovery"]:
            require(result["status"] == "passed" and result["observed"]["outstanding_callers"] == 0
                    and result["observed"]["outstanding_codec_outputs"] == 0 and result["observed"]["violations"] == [], "failed cleanup case")
    for result in cleanup["success_path_comparison"]:
        require(result["encode_bytes_identical"] is True and result["all_decoded_rgba_bytes_identical"] is True, "changed success-path bytes")
    distributions = read_record(verification["distributions"])
    bindings = indexed(distributions["source_map_bindings"], "entry")
    require(set(bindings) == {"index.mjs", "index.cjs", "worker.mjs", "cli.mjs"}
            and distributions["direct_built_worker"] is True, "distribution tests incomplete")
    for entry, binding in bindings.items():
        require(binding["entry_sha256"] == outputs["dist/" + entry]["sha256"]
                and binding["codec_source_sha256"] == SOURCE_AFTER
                and binding["glue_sha256"] == outputs["lib/webp.mjs"]["sha256"], "distribution tested different inputs")
    built = decode_json(read_file(directory, "supersplat/build.json"))
    require(built["webp_overlay"] == identity and isinstance(built["signature"], str) and re.fullmatch(r"[a-f0-9]{64}", built["signature"]), "prepared frontend identity mismatch")
    assets = indexed(built["assets"])
    static = indexed(decode_json(read_file(directory, "supersplat/static-payload-inventory.json")))
    for name in ("webp.mjs", "webp.wasm"):
        path = "static/lib/webp/" + name
        require(path in assets and path in static and all(assets[path][key] == static[path][key] == outputs["lib/" + name][key]
                for key in ("sha256", "size_bytes")), "prepared codec inventory mismatch")
    return {"status": "verified-derived-replacement", "overlay": identity, "evidence_file_count": len(selected),
            "runtime_notice_count": len(notices), "linked_member_count": len(linked),
            "historical_prebuilt_provenance": "unresolved", "scope": "Recorded source/build/notice evidence; frontend bytes and final application require separate binding."}


def verify_webp_evidence(directory: Path, readiness: dict):
    """Return a derived-evidence summary or None for generic/historical evidence.

    Malformed evidence is always rejected; an internal-alpha option cannot
    waive these checks. This function intentionally has no alpha argument.
    """
    try:
        return _verify(Path(directory), readiness)
    except (KeyError, TypeError, AttributeError, IndexError, OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("WebP evidence: incomplete or malformed proof: " + str(error)) from error
