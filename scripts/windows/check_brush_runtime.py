#!/usr/bin/env python3
"""Exercise the real Windows engine, preserving raw evidence in a fresh directory.

This is CLI/GPU evidence only. It does not stand in for native application,
installation, graphics-memory measurement or macOS regression acceptance.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid


def load_smoke():
    path = Path(__file__).resolve().parents[1] / 'macos/smoke-engines.py'
    spec = importlib.util.spec_from_file_location('smoke_validation', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(binary, build_info, backend, dataset, output, iterations=300, probe_only=False):
    smoke = load_smoke()
    output.mkdir(parents=True, exist_ok=False)
    info = json.loads(build_info.read_text(encoding='utf-8'))
    if smoke.sha256(binary) != info['binary_sha256']:
        raise ValueError('Build metadata and executable differ')
    record = {'schema_version': 1, 'binary_sha256': info['binary_sha256'],
              'backend': backend, 'build_info': info, 'checks': [], 'frames': [], 'status': 'running'}
    environment = {**os.environ, 'RUST_LOG': 'info'}
    environment.pop('METORIGIN_BRUSH_LIVE_DIR', None)
    environment.pop('METORIGIN_BRUSH_LIVE_SESSION', None)

    def save():
        smoke.atomic_json(output / 'evidence.json', record)

    def machine(label, args, success=True):
        result = subprocess.run([str(binary), *args], capture_output=True, timeout=180, env=environment)
        (output / (label + '.stdout.json')).write_bytes(result.stdout)
        (output / (label + '.stderr.log')).write_bytes(result.stderr)
        report = json.loads(result.stdout)
        assert len(result.stdout.splitlines()) == 1 and (result.returncode == 0) == success
        record[label] = report
        save()
        return report

    try:
        caps = machine('capabilities', ['--capabilities-json'])
        assert caps['target'] == 'x86_64-pc-windows-msvc'
        assert caps['build_id'] == 'metorigin-windows.1'
        assert 'backend_device_selection' in caps['supported_features']
        probe = machine('probe', ['--probe-json', '--graphics-backend', backend])
        assert probe['backend'] == backend and probe['status'] == 'supported'
        assert probe['device_type'] == 'DiscreteGpu' and probe['device_id'].startswith(backend + ':')
        assert probe['compute']['forward_finite'] and probe['compute']['gradient_finite']
        assert probe['compute']['loss'] > 0 and probe['compute']['gradient_l1'] > 0
        selectors = ['--graphics-backend', backend, '--graphics-device', probe['device_id']]
        repeated = machine('bound-probe', ['--probe-json', *selectors])
        assert repeated['device_id'] == probe['device_id']
        failed = machine('missing-device', ['--probe-json', '--graphics-backend', backend,
                                           '--graphics-device', backend + ':00000000:00000000:00'], False)
        assert failed['status'] == 'failed'
        if probe_only:
            record['status'] = 'passed_probe_only'
            return
        source = dataset.resolve(strict=True)
        assert not any(source.rglob('args.txt')) and not any(source.rglob('*.ply'))
        assert not source.is_relative_to(output) and not output.is_relative_to(source)
        local = output / '输入 数据集'
        shutil.copytree(source, local)
        record['dataset_files'] = {str(p.relative_to(source)).replace('\\', '/'): smoke.sha256(p)
                                   for p in source.rglob('*') if p.is_file()}
        base = [str(local), *selectors, '--max-resolution', '960', '--max-splats', '300000',
                '--max-scene-batch-cache-size', '512MiB', '--sh-degree', '0', '--lod-levels', '0',
                '--num-loader-threads', '2', '--export-name', 'checkpoint_{iter}.ply']

        def run(label, arguments, success=True):
            command = [str(binary), *map(str, arguments)]
            start = time.monotonic()
            with (output / (label + '.log')).open('wb') as log:
                result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                        env=environment, timeout=1800)
            entry = {'label': label, 'argv': command, 'exit_code': result.returncode,
                     'seconds': round(time.monotonic() - start, 3)}
            record['checks'].append(entry)
            save()
            assert (result.returncode == 0) == success, entry
            return entry

        def checkpoint(directory, iteration):
            paths = [p for p in directory.glob('checkpoint_*.ply')
                     if int(re.search(r'_(\d+)\.ply$', p.name)[1]) == iteration]
            assert len(paths) == 1, (directory, iteration)
            return paths[0]

        export = output / '输出 checkpoints'
        entry = run('train', [*base, '--start-iter', '0', '--total-train-iters', iterations,
                              '--export-every', '100', '--export-path', export])
        final = checkpoint(export, iterations)
        entry['checkpoint'] = smoke.validate_ply(final)
        shutil.copyfile(final, local / 'init.ply')
        entry = run('warm-start', [*base, '--start-iter', iterations, '--total-train-iters', iterations+10,
                                   '--export-every', '10', '--export-path', output / '恢复'])
        entry['checkpoint'] = smoke.validate_ply(checkpoint(output / '恢复', iterations+10))
        lower = base.copy()
        lower[lower.index('--max-splats')+1] = '100'
        final_hash = smoke.sha256(final)
        run('reject-downsample', [*lower, '--start-iter', iterations, '--total-train-iters', iterations+10], False)
        assert smoke.sha256(final) == final_hash
        blocked = output / 'blocked-output'
        blocked.write_text('preserve this file', encoding='utf-8')
        run('export-failure', [*base, '--start-iter', iterations, '--total-train-iters', iterations+1,
                               '--export-every', '1', '--export-path', blocked], False)
        assert blocked.read_text(encoding='utf-8') == 'preserve this file'
        (local / 'init.ply').unlink()

        # A fresh UUID and bounded request/ACK stream, with no independent model
        # queue. The process object is the sole authority for force termination.
        session = str(uuid.uuid4())
        live_root = output / 'live'
        directory = live_root / session
        directory.mkdir(parents=True)
        smoke.atomic_json(live_root / 'session.json', {'protocol': 1, 'session_id': session,
                                                     'available': True, 'running': True})
        live_env = {**environment, 'METORIGIN_BRUSH_LIVE_DIR': str(directory),
                    'METORIGIN_BRUSH_LIVE_SESSION': session}
        live_export = output / 'live checkpoints'
        command = [str(binary), *base, '--start-iter', '0', '--total-train-iters', '10000',
                   '--export-every', '100', '--export-path', str(live_export)]
        with (output / 'live-cancel.log').open('wb') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=live_env)
            try:
                def request(revision, mode='live', selected_session=session, expiry=10000):
                    smoke.atomic_json(directory / 'request.json', {'session_id': selected_session,
                        'after_revision': revision, 'mode': mode, 'expires_at_ms': int(time.time()*1000)+expiry})
                request(0, selected_session=str(uuid.uuid4()))
                time.sleep(0.5)
                assert not (directory / 'latest.json').exists()
                request(0, expiry=-1)
                time.sleep(0.5)
                assert not (directory / 'latest.json').exists()
                record['checks'].append({'label': 'old-session-and-expired-request', 'passed': True})
                request(0)
                deadline = time.monotonic()+180
                revision = 0
                while time.monotonic() < deadline and len(record['frames']) < 4:
                    assert process.poll() is None, 'Live producer exited before consuming frames'
                    latest = directory / 'latest.json'
                    if latest.exists():
                        frame = json.loads(latest.read_text(encoding='utf-8'))
                        if frame['revision'] > revision:
                            assert frame['session_id'] == session and frame['revision'] == revision+1
                            validated = smoke.validate_ply(directory / frame['relative_path'])
                            assert validated['vertices'] == frame['splat_count']
                            record['frames'].append({**frame, 'ply': validated})
                            revision = frame['revision']
                            if len(record['frames']) < 4:
                                request(revision)
                    time.sleep(0.05)
                assert len(record['frames']) >= 4
                # Keep the final frame unacknowledged while checking stale ACK;
                # acknowledging first would legitimately allow one more frame
                # before the off request reaches the producer.
                request(revision-1)
                time.sleep(0.3)
                assert json.loads((directory / 'latest.json').read_text(encoding='utf-8'))['revision'] == revision
                request(revision, mode='off')
                time.sleep(0.5)
                stable = json.loads((directory / 'latest.json').read_text(encoding='utf-8'))
                assert stable['revision'] == revision
                assert len(list(directory.glob('frame-*.ply'))) <= 2
                record['checks'].append({'label': 'live-ack-off-retention', 'passed': True})
                deadline = time.monotonic()+180
                while not list(live_export.glob('checkpoint_*.ply')) and time.monotonic() < deadline:
                    assert process.poll() is None
                    time.sleep(0.1)
                committed = sorted(live_export.glob('checkpoint_*.ply'))[-1]
                verified = smoke.validate_ply(committed)
                process.terminate()
                process.wait(timeout=30)
                assert process.poll() is not None
                assert smoke.sha256(committed) == verified['sha256']
                record['checks'].append({'label': 'forced-stop-keeps-complete-checkpoint', 'passed': True,
                                         'exit_code': process.returncode, 'checkpoint': verified})
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=30)
        stopped_iteration = int(re.search(r'_(\d+)\.ply$', committed.name)[1])
        shutil.copyfile(committed, local / 'init.ply')
        recovered = output / 'interruption recovery'
        entry = run('recover-after-stop', [*base, '--start-iter', stopped_iteration,
            '--total-train-iters', stopped_iteration+10, '--export-every', '10', '--export-path', recovered])
        entry['checkpoint'] = smoke.validate_ply(checkpoint(recovered, stopped_iteration+10))
        assert smoke.sha256(committed) == verified['sha256']
        assert smoke.sha256(binary) == record['binary_sha256']
        record['status'] = 'passed_cli_contract'
    except BaseException as error:
        record['status'] = 'failed'
        record['failure'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--brush', type=Path, required=True)
    parser.add_argument('--build-info', type=Path, required=True)
    parser.add_argument('--backend', choices=['dx12', 'vulkan'], required=True)
    parser.add_argument('--dataset', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--iterations', type=int, default=300)
    parser.add_argument('--probe-only', action='store_true')
    args = parser.parse_args()
    if not args.probe_only and args.dataset is None:
        parser.error('--dataset is required except in --probe-only mode')
    if args.iterations < 100 or args.iterations % 100:
        parser.error('--iterations must be a positive multiple of 100')
    check(args.brush.resolve(strict=True), args.build_info.resolve(strict=True), args.backend,
          args.dataset, args.output.resolve(), args.iterations, args.probe_only)
