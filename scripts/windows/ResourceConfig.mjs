import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsPaths } from './WindowsPaths.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function fullBundleConfiguration(options = {}) {
  const repo = path.resolve(options.repositoryRoot ?? repository);
  const paths = await resolveWindowsPaths({ repositoryRoot: repo });
  const pack = path.resolve(repo, options.output ?? paths.distributionRoot);
  const config = JSON.parse(await readFile(path.join(repo, 'apps/desktop/src-tauri/tauri.full.conf.json'), 'utf8'));
  config.bundle.resources = Object.fromEntries(Object.entries(config.bundle.resources).filter(([, target]) =>
    !['resources/engines/', 'resources/licenses/', 'resources/installer/'].includes(target)));
  for (const name of ['engines', 'licenses', 'installer']) config.bundle.resources[`${path.join(pack, name).split(path.sep).join('/')}/`] = `resources/${name}/`;
  return config;
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!['--output', '--config'].includes(flag) || !value) throw new Error('Usage: ResourceConfig.mjs --output PACK --config FILE');
      options[flag.slice(2)] = value;
    }
    if (!options.config) throw new Error('Missing --config');
    const filename = path.resolve(repository, options.config);
    const paths = await resolveWindowsPaths();
    if (!filename.startsWith(`${paths.verification}${path.sep}`)) throw new Error('Generated configuration must stay under the Windows verification directory.');
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `${JSON.stringify(await fullBundleConfiguration(options), null, 2)}\n`, { flag: 'wx' });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
