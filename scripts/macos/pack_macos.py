"""Strict Mach-O closure and schema-1 pack primitives. No global installation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess


SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/")
LOAD_COMMANDS = {"LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB",
                 "LC_LAZY_LOAD_DYLIB", "LC_LOAD_UPWARD_DYLIB"}
MACHO_MAGICS = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe",
                b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}


def run(args: list[str | Path], **kwargs) -> str:
    result = subprocess.run([str(a) for a in args], text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise ValueError(f"command failed ({result.returncode}): {args}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def version_tuple(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(?:\.\d+){0,2}", value):
        raise ValueError(f"invalid macOS minimum version: {value}")
    parts = tuple(int(v) for v in value.split("."))
    return parts + (0,) * (3 - len(parts))


@dataclass
class MachO:
    path: str
    architecture: str
    minimum_os: str
    dependencies: list[str]
    rpaths: list[str]
    install_id: str | None


def parse_load_commands(text: str) -> tuple[str, list[str], list[str], str | None]:
    deps, rpaths, versions, identities = [], [], [], []
    for block in re.split(r"Load command \d+\n", text):
        match = re.search(r"^\s*cmd (\S+)\s*$", block, re.M)
        if not match:
            continue
        cmd = match[1]
        if cmd in LOAD_COMMANDS or cmd == "LC_ID_DYLIB":
            name = re.search(r"^\s*name (.+) \(offset \d+\)\s*$", block, re.M)
            if not name:
                raise ValueError(f"unparseable {cmd}")
            (identities if cmd == "LC_ID_DYLIB" else deps).append(name[1])
        elif cmd == "LC_RPATH":
            path = re.search(r"^\s*path (.+) \(offset \d+\)\s*$", block, re.M)
            if not path:
                raise ValueError("unparseable LC_RPATH")
            rpaths.append(path[1])
        elif cmd == "LC_BUILD_VERSION":
            platform = re.search(r"^\s*platform (\S+)", block, re.M)
            if not platform or platform[1] not in {"1", "MACOS"}:
                raise ValueError("non-macOS build platform")
            versions += re.findall(r"^\s*minos (\S+)", block, re.M)
        elif cmd == "LC_VERSION_MIN_MACOSX":
            versions += re.findall(r"^\s*version (\S+)", block, re.M)
    if len(versions) != 1 or len(identities) > 1:
        raise ValueError("expected one macOS minimum version and at most one dylib ID")
    return versions[0], deps, rpaths, identities[0] if identities else None


def inspect_macho(path: Path, maximum_os: str = "15.0") -> MachO:
    architecture = run(["/usr/bin/lipo", "-archs", path]).strip()
    if architecture != "arm64":
        raise ValueError(f"expected arm64-only: {path}: {architecture}")
    minimum, deps, rpaths, identity = parse_load_commands(run(["/usr/bin/otool", "-l", path]))
    if version_tuple(minimum) > version_tuple(maximum_os):
        raise ValueError(f"minimum OS {minimum} exceeds {maximum_os}: {path}")
    return MachO(str(path), architecture, minimum, deps, rpaths, identity)


def expand_path(value: str, loader: Path, executable: Path) -> Path:
    for token, base in (("@loader_path", loader.parent), ("@executable_path", executable.parent)):
        if value == token or value.startswith(token + "/"):
            return base / value[len(token):].lstrip("/")
    if value.startswith("/"):
        return Path(value)
    raise ValueError(f"unresolved path token: {value}")


def resolve_dependency(value: str, loader: Path, executable: Path,
                       rpaths: list[str], roots: list[Path]) -> Path:
    if value.startswith("@rpath/"):
        candidates = [expand_path(p, loader, executable) / value[7:] for p in rpaths]
        candidates += [root / "lib" / value[7:] for root in roots]
    else:
        candidates = [expand_path(value, loader, executable)]
    for candidate in candidates:
        if candidate.is_file():
            resolved = candidate.resolve()
            if not any(resolved.is_relative_to(root.resolve()) for root in roots):
                raise ValueError(f"dependency escapes declared source roots: {value}: {resolved}")
            return resolved
    raise ValueError(f"unresolved dependency {value} from {loader}")


def collect_closure(executables: dict[str, Path], roots: list[Path]) -> tuple[dict[Path, MachO], dict[Path, dict[str, Path]]]:
    graph: dict[Path, MachO] = {}
    edges: dict[Path, dict[str, Path]] = {}
    todo = [(p.resolve(), p.resolve(), []) for p in executables.values()]
    while todo:
        path, executable, inherited = todo.pop()
        if path in graph:
            continue
        info = inspect_macho(path)
        graph[path] = info
        edges[path] = {}
        # A parent's @loader_path rpath remains anchored to that parent's image
        # when inherited by a child, rather than rebasing to the child directory.
        rpaths = [str(expand_path(value, path, executable)) for value in info.rpaths] + inherited
        for dep in info.dependencies:
            if dep.startswith(SYSTEM_PREFIXES):
                continue
            target = resolve_dependency(dep, path, executable, rpaths, roots)
            edges[path][dep] = target
            todo.append((target, executable, rpaths))
    return graph, edges


def disable_embedded_prefixes(path: Path, specification: dict | None) -> dict | None:
    """Disable compiled developer plugin/config defaults without changing offsets.

    The supported runtime is offline JPEG/PNG SfM. Optional third-party modules,
    dictionaries/fonts/catalogs are not allowed to resolve from the build host.
    Fixed-size replacement preserves Mach-O section/string offsets. Sign later.
    Schema 2 records hashes and byte spans instead of private source path literals.
    """
    if not specification:
        return None
    if specification.get("schema_version") != 2:
        raise ValueError("runtime prefix audit requires schema 2")
    matching = [item for item in specification["files"] if item["name"] == path.name]
    if not matching:
        return None
    if len(matching) != 1:
        raise ValueError("runtime prefix audit has duplicate source identities")
    selected = matching[0]
    data = bytearray(path.read_bytes())
    before = hashlib.sha256(data).hexdigest()
    if before != selected["source_sha256"]:
        raise ValueError("runtime literal audit does not match exact source binary: " + str(path))
    prefix = specification["prefix"]
    prefix_length = prefix["byte_length"]
    marker = b"/__metorigin_disabled__/"
    if type(prefix_length) is not int or not len(marker) <= prefix_length <= len(data):
        raise ValueError("source prefix length is invalid for fixed-width neutralization")
    replacement = marker + b"x" * (prefix_length - len(marker))
    if Path(replacement.decode()).exists():
        raise ValueError("neutralized runtime prefix unexpectedly exists")
    records = []
    reviewed_ranges = []
    for field in selected["fields"]:
        offset = field["offset"]
        length = field["byte_length"]
        if (type(offset) is not int or type(length) is not int or offset <= 0 or length <= 0
                or offset + length >= len(data)):
            raise ValueError("reviewed runtime field is outside source binary: " + str(path))
        end = offset + length
        if any(offset < other_end and other_offset < end for other_offset, other_end in reviewed_ranges):
            raise ValueError("reviewed runtime fields overlap: " + str(path))
        reviewed_ranges.append((offset, end))
        original = bytes(data[offset:end])
        if (hashlib.sha256(original).hexdigest() != field["sha256"]
                or b"\0" in original or data[offset - 1] != 0 or data[end] != 0):
            raise ValueError("reviewed NUL-terminated runtime field differs: " + str(path))
        positions = field["prefix_offsets"]
        if not isinstance(positions, list) or not positions:
            raise ValueError("reviewed runtime field requires prefix offsets: " + str(path))
        previous_end = 0
        original_prefix = None
        changed = bytearray(original)
        for position in positions:
            if (type(position) is not int or position < previous_end
                    or position + prefix_length > length):
                raise ValueError("reviewed runtime prefix span is invalid: " + str(path))
            span = original[position:position + prefix_length]
            if hashlib.sha256(span).hexdigest() != prefix["sha256"]:
                raise ValueError("reviewed runtime prefix hash differs: " + str(path))
            original_prefix = span
            changed[position:position + prefix_length] = replacement
            previous_end = position + prefix_length
        # Every occurrence was replaced by schema 1's bytes.replace. Preserve
        # that exact scope for XML and multi-path fields without storing literals.
        actual_positions = []
        cursor = 0
        while (position := original.find(original_prefix, cursor)) != -1:
            actual_positions.append(position)
            cursor = position + prefix_length
        if actual_positions != positions:
            raise ValueError("reviewed runtime prefix offsets are incomplete: " + str(path))
        changed = bytes(changed)
        if changed == original or len(changed) != len(original):
            raise ValueError("runtime literal replacement must preserve length")
        data[offset:end] = changed
        records.append({**field, "replacement_literal": changed.decode(),
                        "replacement_sha256": hashlib.sha256(changed).hexdigest()})
    path.write_bytes(data)
    return {"before_sha256": before, "after_literal_rewrite_sha256": sha256(path), "fields": records}


def copy_closure(engine_root: Path, executables: dict[str, Path], graph: dict[Path, MachO],
                 edges: dict[Path, dict[str, Path]], runtime_fields: dict | None = None) -> dict[Path, Path]:
    targets: dict[Path, Path] = {}
    embedded_rewrites = []
    names: set[str] = set()
    executable_paths = {p.resolve(): logical for logical, p in executables.items()}
    for source in sorted(graph):
        target = engine_root / ("bin" if source in executable_paths else "lib") / (
            executable_paths[source] if source in executable_paths else source.name)
        key = str(target).casefold()
        if key in names:
            raise ValueError(f"case-insensitive bundled filename collision: {target}")
        names.add(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        target.chmod(0o755)
        changes = disable_embedded_prefixes(target, runtime_fields)
        if changes:
            embedded_rewrites.append({"path": str(target.relative_to(engine_root)), **changes})
        targets[source] = target
    for source, target in targets.items():
        info = graph[source]
        args: list[str | Path] = ["/usr/bin/install_name_tool"]
        for old, dependency in edges[source].items():
            new = "@loader_path/" + os.path.relpath(targets[dependency], target.parent)
            args.extend(["-change", old, new])
        if info.install_id:
            args.extend(["-id", "@loader_path/" + target.name])
        for rpath in dict.fromkeys(info.rpaths):
            args.extend(["-delete_rpath", rpath])
        if len(args) > 1:
            run([*args, target])
    # Dependencies first, executables last; all byte mutations precede signing.
    for source, target in sorted(targets.items(), key=lambda item: item[0] in executable_paths):
        run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", target])
        run(["/usr/bin/codesign", "--verify", "--strict", target])
    for record in embedded_rewrites:
        record["final_signed_sha256"] = sha256(engine_root / record["path"])
    write_json(engine_root / "provenance/embedded-prefix-rewrites.json", {
        "schema_version": 1,
        "policy": "Only exact audited NUL-terminated runtime path/config fields are neutralized; compiler diagnostics remain intact. Offline JPEG/PNG SfM is the supported pack scope.",
        "files": embedded_rewrites})
    return targets


def safe_pack_path(root: Path, name: str) -> Path:
    value = PurePosixPath(name)
    if not name or value.is_absolute() or "\\" in name or any(p in {"", ".", ".."} for p in name.split("/")):
        raise ValueError(f"unsafe manifest path: {name}")
    path = root / name
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"manifest path escapes pack: {name}")
    current = root
    for part in value.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"pack symlink is not permitted: {name}")
        if part not in {child.name for child in current.parent.iterdir()}:
            raise ValueError(f"manifest path has wrong case or is missing: {name}")
    return path


def verify_pack(root: Path) -> dict:
    root = root.resolve()
    manifest = json.loads((root / "engine-manifest.json").read_text())
    if set(manifest) != {"schema_version", "pack_version", "platform", "engines"}:
        raise ValueError("unexpected manifest top-level fields")
    if manifest["schema_version"] != 1 or manifest["platform"] != "macos-arm64" or not manifest["pack_version"]:
        raise ValueError("invalid manifest identity")
    expected = {"ffmpeg": {"ffmpeg", "ffprobe"}, "colmap": {"colmap"}, "brush": {"brush"}}
    if set(manifest["engines"]) != set(expected):
        raise ValueError("manifest must contain exactly ffmpeg, colmap and brush")
    all_paths: set[str] = set()
    macho_reports = []
    all_files = set()
    for engine, record in manifest["engines"].items():
        if set(record) != {"version", "executables", "source_url", "source_sha256", "files", "license_files"}:
            raise ValueError(f"invalid engine fields: {engine}")
        if not record["version"] or not record["source_url"] or not re.fullmatch(r"[0-9a-fA-F]{64}", record["source_sha256"]):
            raise ValueError(f"missing source/version identity: {engine}")
        if set(record["executables"]) != expected[engine] or not record["license_files"]:
            raise ValueError(f"missing executables or license files: {engine}")
        declared = set()
        for entry in record["files"]:
            name = entry["path"]
            if not name.startswith(engine + "/") or name.casefold() in all_paths:
                raise ValueError(f"duplicate or wrong-engine path: {name}")
            all_paths.add(name.casefold())
            path = safe_pack_path(root, name)
            if not path.is_file() or path.stat().st_size != entry["size_bytes"] or sha256(path) != entry["sha256"]:
                raise ValueError(f"file size/hash mismatch: {name}")
            declared.add(name)
            all_files.add(path)
            with path.open("rb") as handle:
                macho = handle.read(4) in MACHO_MAGICS
            if macho:
                info = inspect_macho(path)
                rewrite_path = root / engine / "provenance/embedded-prefix-rewrites.json"
                if rewrite_path.is_file():
                    rewrite = json.loads(rewrite_path.read_text())
                    contents = path.read_bytes()
                    for rewrite_record in rewrite["files"]:
                        if engine + "/" + rewrite_record["path"] != name:
                            continue
                        if sha256(path) != rewrite_record["final_signed_sha256"]:
                            raise ValueError("runtime literal audit final hash mismatch: " + name)
                        for field in rewrite_record["fields"]:
                            offset = field["offset"]
                            end = offset + field["byte_length"]
                            if contents[offset:end] != field["replacement_literal"].encode() or contents[end] != 0:
                                raise ValueError("audited runtime path neutralization mismatch: " + name)
                if info.rpaths:
                    raise ValueError(f"LC_RPATH remains in bundled file: {name}: {info.rpaths}")
                if info.install_id and info.install_id != "@loader_path/" + path.name:
                    raise ValueError(f"invalid packaged dylib ID: {name}: {info.install_id}")
                for dep in info.dependencies:
                    if dep.startswith(SYSTEM_PREFIXES):
                        continue
                    if not dep.startswith("@loader_path/"):
                        raise ValueError(f"external dependency: {name}: {dep}")
                    target = (path.parent / dep[len("@loader_path/"):]).resolve()
                    if not target.is_relative_to(root / engine) or not target.is_file():
                        raise ValueError(f"missing or escaped dependency: {name}: {dep}")
                run(["/usr/bin/codesign", "--verify", "--strict", path])
                info.path = name
                macho_reports.append(asdict(info))
        if not set(record["license_files"]).issubset(declared):
            raise ValueError(f"license not hash-declared: {engine}")
        for name in record["executables"].values():
            if name not in declared or not os.access(root / name, os.X_OK):
                raise ValueError(f"executable not declared or executable: {name}")
            inspect_macho(root / name)
    actual = {path for path in root.rglob("*") if path.is_file() and path != root / "engine-manifest.json"}
    if actual != all_files:
        raise ValueError(f"undeclared or missing pack files: {sorted(str(p) for p in actual ^ all_files)}")
    return {"schema_version": 1, "manifest_sha256": sha256(root / "engine-manifest.json"),
            "file_count": len(all_files), "macho_count": len(macho_reports),
            "total_bytes": sum(p.stat().st_size for p in all_files),
            "architecture": "arm64", "maximum_minimum_os": "15.0", "mach_o": macho_reports}
