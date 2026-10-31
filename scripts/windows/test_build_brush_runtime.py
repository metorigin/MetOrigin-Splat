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

    def test_offline_dxc_requires_verified_archive_and_members(self):
        root = self.output / 'recipe-root'
        archive = root / 'target/windows-brush/downloads/dxc.zip'
        archive.parent.mkdir(parents=True)
        compiler = {'archive_name': 'dxc.zip', 'url': 'https://example.invalid/never-fetch',
                    'sha256': '0' * 64, 'files': {'bin/dxcompiler.dll': {
                        'archive_path': 'bin/x64/dxcompiler.dll',
                        'sha256': hashlib.sha256(b'fixed-test-compiler').hexdigest()}}}
        with patch.object(recipe, 'ROOT', root):
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

    def test_os_build_lock_releases_after_exception(self):
        path = self.output / 'build.lock'
        with self.assertRaises(RuntimeError):
            with recipe.build_lock(path):
                raise RuntimeError('injected build interruption')
        with recipe.build_lock(path):
            pass


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

    def test_unrelated_source_edit_is_rejected_without_rewriting(self):
        self.file.write_bytes(b'user edit\n')
        with self.assertRaisesRegex(ValueError, 'differs from'):
            self.prepare()
        self.assertEqual(self.file.read_bytes(), b'user edit\n')


if __name__ == '__main__':
    unittest.main()
