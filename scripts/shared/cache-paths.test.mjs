import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveCachePaths } from './cache-paths.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cache paths 中文 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'packaging/shared/cache-paths.json');
  mkdirSync(join(root, 'packaging/shared'), { recursive: true });
  const config = JSON.parse(readFileSync(new URL('../../packaging/shared/cache-paths.json', import.meta.url), 'utf8'));
  const save = () => writeFileSync(configPath, JSON.stringify(config));
  save();
  return { root, configPath, config, save };
}

test('cache layout keeps disposable sources and npm data outside Cargo without creating files', t => {
  const f = fixture(t);
  const paths = resolveCachePaths({ repositoryRoot: f.root });
  assert.equal(paths.root, join(f.root, '.cache/metorigin'));
  assert.equal(paths.supersplatSourceRoot, join(paths.root, 'sources/supersplat'));
  assert.equal(paths.supersplatSource, join(paths.supersplatSourceRoot, 'upstream'));
  assert.equal(paths.supersplatNpm, join(paths.root, 'downloads/npm/supersplat'));
  assert.equal(existsSync(paths.root), false);
  assert.equal(existsSync(join(f.root, 'target')), false);
});

test('all consumers can resolve a different configured root and source location', t => {
  const f = fixture(t);
  f.config.root = 'local cache';
  f.config.directories.supersplatSource = 'checkout/editor';
  f.config.directories.supersplatNpm = 'npm data';
  f.save();
  const paths = resolveCachePaths({ repositoryRoot: f.root });
  assert.equal(paths.supersplatSource, join(f.root, 'local cache/checkout/editor/upstream'));
  assert.equal(paths.supersplatNpm, join(f.root, 'local cache/npm data'));
  assert.equal(existsSync(paths.root), false);
});

test('invalid cache schemas and escaping paths fail without filesystem mutation', t => {
  const f = fixture(t);
  for (const version of [0, 2, true, '1']) {
    f.config.schema_version = version;
    f.save();
    assert.throws(() => resolveCachePaths({ repositoryRoot: f.root }));
  }
  f.config.schema_version = 1;
  for (const invalid of ['../outside', '/outside', 'C:\\outside', '..\\outside', '.', 'reports/../outside', 'reports\nother']) {
    f.config.root = invalid;
    f.save();
    assert.throws(() => resolveCachePaths({ repositoryRoot: f.root }));
    f.config.root = '.cache/metorigin';
    for (const key of ['supersplatSource', 'supersplatNpm']) {
      const original = f.config.directories[key];
      f.config.directories[key] = invalid;
      f.save();
      assert.throws(() => resolveCachePaths({ repositoryRoot: f.root }));
      f.config.directories[key] = original;
    }
  }
  delete f.config.directories.supersplatSource;
  f.save();
  assert.throws(() => resolveCachePaths({ repositoryRoot: f.root }));
  assert.equal(existsSync(join(f.root, '.cache')), false);
});

test('CLI works from another cwd and linked checkout, and rejects unknown kinds', t => {
  const f = fixture(t);
  const script = join(f.root, 'scripts/shared/cache-paths.mjs');
  mkdirSync(join(f.root, 'scripts/shared'), { recursive: true });
  cpSync(new URL('./cache-paths.mjs', import.meta.url), script);
  const linked = join(f.root, 'linked checkout');
  symlinkSync(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const run = args => spawnSync(process.execPath, [join(linked, 'scripts/shared/cache-paths.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const source = run(['--kind', 'source']);
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout.trim(), resolveCachePaths({ repositoryRoot: f.root }).supersplatSource);
  const all = run([]);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout), resolveCachePaths({ repositoryRoot: f.root }));
  for (const args of [['--kind'], ['--kind', 'unknown'], ['--unknown']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.equal(existsSync(join(f.root, '.cache')), false);
});
