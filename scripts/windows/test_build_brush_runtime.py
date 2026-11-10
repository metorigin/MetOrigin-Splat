"""Deterministic corruption/input tests for Windows runtime cache validation."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import subprocess
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('runtime_build', Path(__file__).with_name('build_brush_runtime.py'))
recipe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recipe)

CHECK_SPEC = importlib.util.spec_from_file_location('runtime_check', Path(__file__).with_name('check_brush_runtime.py'))
checker = importlib.util.module_from_spec(CHECK_SPEC)
CHECK_SPEC.loader.exec_module(checker)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name)
        self.expected = {'lock': {'engine_version': '1.0.0+metorigin-windows.1',
                                 'build_id': 'metorigin-windows.1',
                                 'target': 'x86_64-pc-windows-msvc', 'source_commit': 'a' * 40}}
        self.cap = {**self.expected['lock'], 'supported_features': ['backend_device_selection']}
        for name in ['bin/brush-cli.exe', 'version.txt', 'help.txt', 'capabilities.json',
                     'target-tree.txt', 'Cargo.lock', 'BRUSH-LICENSE', 'LPIPS-AUDIT.md']:
            path = self.output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
        self.info = {'inputs': self.expected, 'files': {
            str(path.relative_to(self.output)).replace('\\', '/'): recipe.sha(path)
            for path in self.output.rglob('*') if path.is_file()},
            'binary_sha256': recipe.sha(self.output / 'bin/brush-cli.exe')}
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        (self.output / 'BUILD-INFO.json').write_text(json.dumps(self.info), encoding='utf-8')

    def check(self, cap=None):
        with patch.object(recipe, 'run', return_value=json.dumps(cap or self.cap).encode()):
            return recipe.verify(self.output, self.expected)

    def test_complete_cache_and_identity(self):
        self.assertEqual(self.check(), self.info)

    def test_corrupt_binary_or_missing_inventory_cannot_be_reused(self):
        (self.output / 'bin/brush-cli.exe').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            self.check()
        del self.info['files']['bin/brush-cli.exe']
        self.save()
        with self.assertRaises(ValueError):
            self.check()

    def test_unknown_files_and_changed_inputs_refuse_cache(self):
        extra = self.output / 'untracked.dll'
        extra.write_bytes(b'unknown')
        with self.assertRaises(ValueError):
            self.check()
        extra.unlink()
        self.info['inputs'] = copy.deepcopy(self.expected)
        self.info['inputs']['lock']['target'] = 'aarch64-apple-darwin'
        self.save()
        with self.assertRaises(ValueError):
            self.check()

    def test_machine_identity_is_checked_after_hashes(self):
        cap = copy.deepcopy(self.cap)
        cap['build_id'] = 'stock'
        with self.assertRaises(ValueError):
            self.check(cap)

    def test_dll_and_rewritten_receipt_still_require_pinned_archive_hash(self):
        path = self.output / 'bin/dxcompiler.dll'
        path.write_bytes(b'substituted compiler')
        self.expected['lock']['dxc'] = {'files': {'bin/dxcompiler.dll': {'sha256': 'a' * 64}}}
        self.info['files']['bin/dxcompiler.dll'] = recipe.sha(path)
        self.save()
        with self.assertRaisesRegex(ValueError, 'pinned archive provenance'):
            self.check()

    def test_offline_dxc_requires_verified_archive_and_members(self):
        root = self.output / 'recipe-root'
        archive = root / '.cache/metorigin/downloads/dxc/windows-x64/dxc.zip'
        archive.parent.mkdir(parents=True)
        compiler = {'archive_name': 'dxc.zip', 'url': 'https://example.invalid/never-fetch',
                    'sha256': '0' * 64, 'files': {'bin/dxcompiler.dll': {
                        'archive_path': 'bin/x64/dxcompiler.dll',
                        'sha256': hashlib.sha256(b'fixed-test-compiler').hexdigest()}}}
        with patch.object(recipe, 'runtime_paths', return_value={'brushDxcDownloads': archive.parent}):
            with self.assertRaisesRegex(ValueError, 'Offline build requires'):
                recipe.prepare_dxc({'dxc': compiler}, True)
            with zipfile.ZipFile(archive, 'w') as zipped:
                zipped.writestr('bin/x64/dxcompiler.dll', b'fixed-test-compiler')
            with self.assertRaisesRegex(ValueError, 'archive checksum mismatch'):
                recipe.prepare_dxc({'dxc': compiler}, True)
            compiler['sha256'] = recipe.sha(archive)
            self.assertEqual(recipe.prepare_dxc({'dxc': compiler}, True),
                             {'bin/dxcompiler.dll': b'fixed-test-compiler'})
            compiler['files']['bin/dxcompiler.dll']['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'file does not match'):
                recipe.prepare_dxc({'dxc': compiler}, True)

    def test_missing_source_never_downloads_offline_or_replaces_an_explicit_repository(self):
        source = self.output / 'cache/upstream'
        with patch.object(recipe, 'runtime_paths', return_value={'brushSource': source}), patch.object(recipe, 'run') as invoke:
            with self.assertRaisesRegex(ValueError, 'Offline build requires'):
                recipe.prepare_source_repository(source, {}, True)
            with self.assertRaisesRegex(ValueError, 'Explicit Brush source repository does not exist'):
                recipe.prepare_source_repository(self.output / 'user-repository', {}, False)
            invoke.assert_not_called()
        self.assertFalse(source.exists())

    def test_only_missing_default_source_cache_uses_the_locked_remote_and_commit(self):
        source = self.output / 'cache/upstream'
        lock = {'source_repository': 'https://example.invalid/locked-source', 'source_commit': 'a' * 40}
        with patch.object(recipe, 'runtime_paths', return_value={'brushSource': source}), patch.object(recipe, 'run') as invoke:
            recipe.prepare_source_repository(source, lock, False)
            self.assertEqual(invoke.call_args_list[0].args[0], ['git', 'clone', '--no-checkout', lock['source_repository'], source])
            self.assertEqual(invoke.call_args_list[1].args[0][-1], lock['source_commit'] + '^{commit}')
            source.mkdir()
            (source / 'keep.txt').write_text('existing caller source')
            invoke.reset_mock()
            recipe.prepare_source_repository(source, lock, False)
            invoke.assert_not_called()
        self.assertEqual((source / 'keep.txt').read_text(), 'existing caller source')

    def test_os_build_lock_releases_after_exception(self):
        path = self.output / 'build.lock'
        with self.assertRaises(RuntimeError):
            with recipe.build_lock(path):
                raise RuntimeError('injected build interruption')
        with recipe.build_lock(path):
            pass


class CliIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.binary = self.root / 'pack/bin/brush-cli.exe'
        self.binary.parent.mkdir(parents=True)
        self.files = {}
        for name in ['brush-cli.exe', 'dxcompiler.dll', 'dxil.dll']:
            path = self.binary.with_name(name)
            path.write_bytes(('fixture ' + name).encode())
            self.files['bin/' + name] = recipe.sha(path)
        self.locks = []
        self.lock_directory = self.root / 'locks'
        self.lock_directory.mkdir()
        for index, name in enumerate(['source-lock.json', 'source-lock.windows1-legacy.json']):
            lock = {'schema_version': 1, 'source_commit': 'a' * 40,
                    'engine_version': '1.0.0+metorigin-windows.1',
                    'build_id': 'metorigin-windows.1', 'target': 'x86_64-pc-windows-msvc',
                    'patches': [{'path': f'patch-{index}', 'sha256': str(index) * 64}],
                    'cargo_lock_sha256': str(index) * 64,
                    'combined_source_diff_sha256': str(index) * 64,
                    'dxc': {'files': {path: {'sha256': digest} for path, digest in self.files.items()
                                     if path.endswith('.dll')}}}
            self.locks.append(lock)
            (self.lock_directory / name).write_text(json.dumps(lock), encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def receipt(self, lock):
        return {'schema_version': 1, 'inputs': {'lock': copy.deepcopy(lock)},
                'files': self.files.copy(), 'binary_sha256': self.files['bin/brush-cli.exe']}

    def check(self, info):
        with patch.object(checker, 'SOURCE_LOCK_DIRECTORY', self.lock_directory):
            checker.verify_integrity(self.binary, info)

    def test_only_complete_current_and_shipped_recipes_are_accepted(self):
        for lock in self.locks:
            with self.subTest(recipe=lock['patches']):
                self.check(self.receipt(lock))
                for key, value in [('patches', []), ('target', 'aarch64-apple-darwin'),
                                   ('cargo_lock_sha256', 'f' * 64),
                                   ('combined_source_diff_sha256', 'f' * 64)]:
                    info = self.receipt(lock)
                    info['inputs']['lock'][key] = value
                    with self.assertRaisesRegex(ValueError, 'complete pinned'):
                        self.check(info)

    def test_top_level_and_inventory_binary_hashes_must_agree(self):
        info = self.receipt(self.locks[0])
        info['binary_sha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'binary hash disagrees'):
            self.check(info)

    def test_rewritten_dll_receipt_cannot_replace_fixed_source_hash(self):
        info = self.receipt(self.locks[0])
        compiler = self.binary.with_name('dxcompiler.dll')
        compiler.write_bytes(b'substituted DLL')
        info['files']['bin/dxcompiler.dll'] = recipe.sha(compiler)
        with self.assertRaisesRegex(ValueError, 'pinned provenance'):
            self.check(info)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.git('init')
        self.git('config', 'core.autocrlf', 'false')
        self.file = self.source / 'contract.txt'
        self.file.write_bytes(b'base\n')
        (self.source / 'Cargo.lock').write_bytes(b'locked\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Recipe Test', '-c', 'user.email=recipe@example.invalid',
                 'commit', '-m', 'fixture')
        commit = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('checkout', '--detach', commit)
        self.file.write_bytes(b'mac\n')
        first = self.git(*recipe.DIFF)
        self.git('add', '.')
        self.file.write_bytes(b'windows\n')
        second = self.git(*recipe.DIFF[:-1])
        self.git('reset', '--mixed', 'HEAD')
        combined = self.git(*recipe.DIFF)
        self.file.write_bytes(b'base\n')
        (self.root / 'first.patch').write_bytes(first)
        (self.root / 'second.patch').write_bytes(second)
        self.lock = {'source_commit': commit, 'patches': [
            {'path': 'first.patch', 'sha256': hashlib.sha256(first).hexdigest()},
            {'path': 'second.patch', 'sha256': hashlib.sha256(second).hexdigest()}],
            'combined_source_diff_sha256': hashlib.sha256(combined).hexdigest(),
            'cargo_lock_sha256': recipe.sha(self.source / 'Cargo.lock')}

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], stderr=subprocess.PIPE)

    def tearDown(self):
        # Git stores read-only object files; TemporaryDirectory's cleanup deals
        # with their permissions on Windows without touching any user checkout.
        self.temp.cleanup()

    def prepare(self):
        with patch.object(recipe, 'ROOT', self.root):
            recipe.prepare_source(self.source, self.source, self.lock)

    def test_pristine_and_complete_sources_are_reproducible(self):
        self.prepare()
        self.assertEqual(self.file.read_bytes(), b'windows\n')
        self.prepare()
        self.assertEqual(self.file.read_bytes(), b'windows\n')

    def test_interrupted_after_first_exact_patch_resumes_only_delta(self):
        self.git('apply', '--intent-to-add', str(self.root / 'first.patch'))
        self.prepare()
        self.assertEqual(self.file.read_bytes(), b'windows\n')

    def test_third_delta_resumes_only_an_exact_pinned_two_patch_prefix(self):
        self.prepare()
        prefix = self.git(*recipe.DIFF)
        self.git('add', '.')
        self.file.write_bytes(b'resilient\n')
        third = self.git(*recipe.DIFF[:-1])
        self.git('reset', '--mixed', 'HEAD')
        combined = self.git(*recipe.DIFF)
        self.file.write_bytes(b'windows\n')
        (self.root / 'third.patch').write_bytes(third)
        self.lock['patches'][1]['applied_source_diff_sha256'] = hashlib.sha256(prefix).hexdigest()
        self.lock['patches'].append({'path': 'third.patch', 'sha256': hashlib.sha256(third).hexdigest()})
        self.lock['combined_source_diff_sha256'] = hashlib.sha256(combined).hexdigest()
        self.prepare()
        self.assertEqual(self.file.read_bytes(), b'resilient\n')
        self.prepare()
        self.assertEqual(self.file.read_bytes(), b'resilient\n')

    def test_unrelated_source_edit_is_rejected_without_rewriting(self):
        self.file.write_bytes(b'user edit\n')
        with self.assertRaisesRegex(ValueError, 'differs from'):
            self.prepare()
        self.assertEqual(self.file.read_bytes(), b'user edit\n')


if __name__ == '__main__':
    unittest.main()
