#!/usr/bin/env python3
"""Build the Windows delta AFTER the frozen Mac integration in an isolated clone.

Never modifies the source repository. --verify is read-only and --offline never
downloads. An artifact is published only after identity, graph and hash checks.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / 'integrations/brush-windows/source-lock.json'
DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames',
        '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', 'HEAD']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, cwd=ROOT):
    return subprocess.check_output([str(arg) for arg in args], cwd=cwd, stderr=subprocess.PIPE)


@contextmanager
def build_lock(path):
    """The OS releases the byte lock after a killed/interrupted builder."""
    with path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def inputs(lock):
    for patch in lock['patches']:
        if sha(ROOT / patch['path']) != patch['sha256']:
            raise ValueError('Pinned Brush patch checksum mismatch: ' + patch['path'])
    rust = run(['rustc', '+' + lock['rust_version'], '-vV']).decode().strip()
    if not rust.startswith('rustc ' + lock['rust_version'] + ' '):
        raise ValueError('Brush requires the pinned Rust compiler')
    return dict(lock=lock, rustc=rust, features=[],
                rustflags=os.environ.get('RUSTFLAGS', ''),
                cargo_encoded_rustflags=os.environ.get('CARGO_ENCODED_RUSTFLAGS', ''))


def verify(output, expected):
    info = json.loads((output / 'BUILD-INFO.json').read_text(encoding='utf-8'))
    if info['inputs'] != expected:
        raise ValueError('Cached Brush build inputs differ from the frozen recipe')
    required = {'bin/brush-cli.exe', 'version.txt', 'help.txt', 'capabilities.json',
                'target-tree.txt', 'Cargo.lock', 'BRUSH-LICENSE', 'LPIPS-AUDIT.md'}
    required.update(expected['lock'].get('dxc', {}).get('files', {}))
    actual = {str(path.relative_to(output)).replace('\\', '/') for path in output.rglob('*')
              if path.is_file() and path.name != 'BUILD-INFO.json'}
    if not required.issubset(info['files']) or actual != set(info['files']):
        raise ValueError('Cached Brush artifact inventory is incomplete or changed')
    for relative, digest in info['files'].items():
        candidate = (output / relative).resolve()
        if not candidate.is_relative_to(output.resolve()) or sha(candidate) != digest:
            raise ValueError('Cached Brush artifact is missing or corrupt: ' + relative)
    binary = output / 'bin/brush-cli.exe'
    if sha(binary) != info['binary_sha256'] or info['files']['bin/brush-cli.exe'] != info['binary_sha256']:
        raise ValueError('Brush binary hash disagrees with its build identity')
    capabilities = json.loads(run([binary, '--capabilities-json']))
    lock = expected['lock']
    for key, value in {'engine_version': lock['engine_version'], 'build_id': lock['build_id'],
                       'target': lock['target'], 'source_commit': lock['source_commit']}.items():
        if capabilities.get(key) != value:
            raise ValueError('Brush binary identity mismatch: ' + key)
    if 'backend_device_selection' not in capabilities.get('supported_features', []):
        raise ValueError('Windows Brush does not implement verified adapter binding')
    return info


def prepare_source(source_repo, source, lock):
    if not source.exists():
        run(['git', 'clone', '--config', 'core.autocrlf=false', '--no-hardlinks', '--no-checkout', source_repo, source])
        run(['git', '-C', source, 'checkout', '--detach', lock['source_commit']])
    if run(['git', '-C', source, 'rev-parse', 'HEAD']).decode().strip() != lock['source_commit']:
        raise ValueError('Isolated Brush source revision changed')
    branch = subprocess.run(['git', '-C', str(source), 'symbolic-ref', '--quiet', 'HEAD'],
                            capture_output=True)
    if branch.returncode != 1:
        raise ValueError('Brush build requires a detached isolated checkout')
    staged = subprocess.run(['git', '-C', str(source), 'diff', '--cached', '--quiet'], capture_output=True)
    if staged.returncode != 0 or run(['git', '-C', source, 'ls-files', '--others', '--exclude-standard']):
        raise ValueError('Isolated Brush source contains staged or untracked edits')
    diff = run(['git', '-C', source, *DIFF])
    diff_hash = hashlib.sha256(diff).hexdigest()
    # An interrupted preparation may leave the pristine detached tree or
    # exactly the first frozen patch. Only those states can be resumed safely.
    remaining = lock['patches'] if not diff else (
        lock['patches'][1:] if diff_hash == lock['patches'][0]['sha256'] else [])
    for patch in remaining:
        run(['git', '-C', source, 'apply', '--check', ROOT / patch['path']])
        run(['git', '-C', source, 'apply', '--intent-to-add', ROOT / patch['path']])
    diff_hash = hashlib.sha256(run(['git', '-C', source, *DIFF])).hexdigest()
    if diff_hash != lock['combined_source_diff_sha256'] or sha(source / 'Cargo.lock') != lock['cargo_lock_sha256']:
        raise ValueError('Isolated Brush source differs from the two ordered frozen patches')


def prepare_dxc(lock, offline):
    compiler = lock['dxc']
    archive = ROOT / 'target/windows-brush/downloads' / compiler['archive_name']
    if not archive.exists():
        if offline:
            raise ValueError('Offline build requires the pinned DXC archive: ' + str(archive))
        archive.parent.mkdir(parents=True, exist_ok=True)
        temporary = archive.with_suffix('.download-' + str(os.getpid()))
        urllib.request.urlretrieve(compiler['url'], temporary)
        if sha(temporary) != compiler['sha256']:
            raise ValueError('Downloaded DXC archive checksum mismatch')
        temporary.replace(archive)
    if sha(archive) != compiler['sha256']:
        raise ValueError('Pinned DXC archive checksum mismatch')
    files = {}
    with zipfile.ZipFile(archive) as zipped:
        for destination, item in compiler['files'].items():
            data = zipped.read(item['archive_path'])
            if hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('DXC file does not match pinned archive provenance')
            files[destination] = data
    return files


def build(source_repo, output, offline=False, verify_only=False):
    lock = json.loads(LOCK.read_text(encoding='utf-8'))
    expected = inputs(lock)
    key = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
    if output.exists():
        verify(output, expected)
        print('Verified Windows Brush cache: ' + str(output))
        return
    if verify_only:
        raise ValueError('No verified Windows Brush runtime exists at the requested output')
    compiler_files = prepare_dxc(lock, offline)
    build_root = ROOT / 'target/windows-brush' / key
    build_root.mkdir(parents=True, exist_ok=True)
    source = build_root / 'source'
    cargo = ['cargo', '+' + lock['rust_version']]
    cargo_target = ROOT / 'target/windows-brush/cargo'
    common = ['--locked', '--manifest-path', source / 'Cargo.toml', '-p', 'brush-cli', '--target', lock['target']]
    if offline:
        common.append('--offline')
    # Hold a lock for the entire build and publish; concurrent callers fail
    # explicitly instead of sharing an incomplete staging pack.
    lock_path = build_root / 'build.lock'
    with build_lock(lock_path):
            prepare_source(source_repo, source, lock)
            staging = build_root / ('staging-' + str(os.getpid()))
            staging.mkdir()
            (staging / 'bin').mkdir()
            print('Building Windows Brush from frozen patches; cache=' + key, flush=True)
            subprocess.run([str(arg) for arg in cargo + ['build', '--release', *common,
                            '--target-dir', cargo_target]], check=True, cwd=ROOT)
            prepare_source(source_repo, source, lock)
            if json.loads(LOCK.read_text(encoding='utf-8')) != lock:
                raise ValueError('Frozen source lock changed during compilation')
            binary = cargo_target / lock['target'] / 'release/brush-cli.exe'
            shutil.copyfile(binary, staging / 'bin/brush-cli.exe')
            for destination, data in compiler_files.items():
                path = staging / destination
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            for flag, name in [('--version', 'version.txt'), ('--help', 'help.txt'),
                               ('--capabilities-json', 'capabilities.json')]:
                (staging / name).write_bytes(run([binary, flag]))
            tree = run(cargo + ['tree', *common, '--edges', 'normal,build', '--format', '{p} {l}'])
            (staging / 'target-tree.txt').write_bytes(tree)
            text = tree.decode()
            for package in ['lpips', 'lpips-convert', 'hex-slice', 'indicatif-log-bridge', 'rerun']:
                if re.search(r'(?<![\w-])' + package + r' v', text):
                    raise ValueError('Excluded dependency appears in Windows target graph: ' + package)
            capabilities = json.loads((staging / 'capabilities.json').read_bytes())
            if capabilities['lpips']['embedded_weights'] or capabilities['rerun']['available']:
                raise ValueError('Distribution-only dependencies were enabled')
            # The known unreviewed packed weights must not be retained by linker.
            weights = (source / 'crates/lpips/burn_mapped.bpk').read_bytes()
            data = binary.read_bytes()
            if any(weights[(len(weights)-4096)*i//63:][:4096] in data for i in range(64)):
                raise ValueError('Excluded LPIPS packed weights found in binary')
            shutil.copyfile(source / 'LICENSE', staging / 'BRUSH-LICENSE')
            shutil.copyfile(ROOT / 'integrations/brush-macos/LPIPS-AUDIT.md', staging / 'LPIPS-AUDIT.md')
            shutil.copyfile(source / 'Cargo.lock', staging / 'Cargo.lock')
            files = {str(path.relative_to(staging)).replace('\\', '/'): sha(path)
                     for path in staging.rglob('*') if path.is_file()}
            info = {'schema_version': 1, 'inputs': expected, 'cache_key': key, 'files': files,
                    'binary_sha256': sha(binary), 'lpips_weights_embedded': False,
                    'native_rerun_enabled': False, 'distribution_policy': 'optional_dependencies_excluded',
                    'gpu_validation': 'not_run', 'license_audit': 'target_graph_recorded_not_yet_distribution_approved'}
            (staging / 'BUILD-INFO.json').write_text(json.dumps(info, indent=2) + '\n', encoding='utf-8')
            verify(staging, expected)
            output.parent.mkdir(parents=True, exist_ok=True)
            # Windows rename fails if output appeared concurrently. Never replace
            # another cache or erase an existing candidate on failure.
            staging.rename(output)
            print('Built and verified Windows Brush: ' + str(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-repository', type=Path, default=ROOT.parent / 'brush')
    parser.add_argument('--output', type=Path, default=ROOT / 'target/windows-brush/runtime')
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    try:
        build(args.source_repository.resolve(), args.output.resolve(), args.offline, args.verify)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode(errors='replace'), file=sys.stderr)
        parser.exit(1, 'Windows Brush preparation failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
