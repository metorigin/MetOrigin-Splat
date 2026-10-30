import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fontInputs = [
  ['@fontsource-variable/inter', 'files/inter-latin-wght-normal.woff2', 'inter.woff2'],
  ['@fontsource/jetbrains-mono', 'files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono.woff2'],
];

export async function themeInputs(integration) {
  const root = resolve(integration, '../..');
  const files = [];
  const names = (await readdir(join(integration, 'ui-theme'))).sort();
  for (const required of ['apply.mjs', 'controls.css', 'runtime.ts', 'presentation.ts', 'source-inputs.json']) {
    if (!names.includes(required)) throw new Error(`Missing SuperSplat UI theme input: ${required}`);
  }
  for (const name of names) {
    if (name.endsWith('.test.mjs')) continue;
    const path = join(integration, 'ui-theme', name);
    files.push({ path: `integrations/supersplat/ui-theme/${name}`, sha256: sha256(await readFile(path)) });
  }
  files.push({ path: 'integrations/jan/theme.json', sha256: sha256(await readFile(join(root, 'integrations/jan/theme.json'))) });
  for (const path of ['integrations/jan/upstream/LICENSE', 'integrations/jan/licenses/Apache-2.0.txt']) {
    files.push({ path, sha256: sha256(await readFile(join(root, path))) });
  }
  for (const [pkg, name] of fontInputs) {
    for (const relative of [name, 'LICENSE']) {
      const path = `apps/desktop/node_modules/${pkg}/${relative}`;
      files.push({ path, sha256: sha256(await readFile(join(root, path))) });
    }
  }
  return files;
}

export async function applyThemeSources(integration, source) {
  const themeRoot = join(integration, 'ui-theme');
  const inputs = JSON.parse(await readFile(join(themeRoot, 'source-inputs.json'), 'utf8'));
  // Fail closed when the fixed upstream bytes differ. Never patch a user's source tree.
  for (const entry of inputs.files) {
    if (sha256(await readFile(join(source, entry.upstreamPath))) !== entry.upstreamSha256) {
      throw new Error(`Pinned SuperSplat UI input differs: ${entry.upstreamPath}`);
    }
  }
  await cp(join(themeRoot, 'runtime.ts'), join(source, 'src/ui/metorigin-theme.ts'));
  await cp(join(themeRoot, 'presentation.ts'), join(source, 'src/ui/metorigin-presentation.ts'));
  const patch = async (name, changes) => {
    const path = join(source, 'src/ui', name);
    let text = await readFile(path, 'utf8');
    for (const [before, after] of changes) {
      if (!text.includes(before)) throw new Error(`SuperSplat UI patch anchor differs: ${name}`);
      text = text.replace(before, after);
    }
    await writeFile(path, text);
  };
  await patch('menu.ts', [
    ['        buttonsContainer.append(home);\n        buttonsContainer.append(separator);',
      '        if (window.parent === window) {\n            buttonsContainer.append(home);\n            buttonsContainer.append(separator);\n        }'],
  ]);
  await patch('histogram.ts', [
    ["import { Events }", "import { uiPaint, uiPixel } from './metorigin-theme';\nimport { Events }"],
    ["context.fillStyle = 'black';", 'context.fillStyle = uiPaint().background;'],
    ["        let dragging = false;", "        window.addEventListener('metorigin-ui-theme', () => this.render());\n        let dragging = false;"],
    ['const mappedUnselected = this.mappedUnselected;', 'const mappedUnselected = this.mappedUnselected;\n        const paint = uiPaint();\n        const background = uiPixel(paint.background);\n        const unselectedColor = uiPixel(paint.muted);\n        const selectedColor = uiPixel(paint.primary);'],
    ['pixels[i++] = 0xff000000;', 'pixels[i++] = background;'],
    ['pixels[i++] = 0xffff7777;', 'pixels[i++] = unselectedColor;'],
    ['pixels[i++] = 0xff00ffff;', 'pixels[i++] = selectedColor;'],
  ]);
  await patch('perf-overlay.ts', [
    ['        let lastText = 0;', '        let lastText = 0;\
        let lastPlot: { values: number[]; median: number; scale: number } | undefined;'],
    ["        events.on('view.perfOverlay',", "        window.addEventListener('metorigin-ui-theme', () => { if (lastPlot) draw(lastPlot.values, lastPlot.median, lastPlot.scale); });\
        events.on('view.perfOverlay',"],
    ["import { Events }", "import { uiPaint } from './metorigin-theme';\nimport { Events }"],
    ['ctx.fillStyle = GRAPH_BG;', 'lastPlot = { values, median, scale };\n            ctx.fillStyle = uiPaint().background;'],
    ['ctx.fillStyle = GRAPH_BAR;', 'ctx.fillStyle = uiPaint().primary;'],
    ['ctx.fillStyle = GRAPH_MEDIAN;', 'ctx.fillStyle = uiPaint().foreground;'],
    ["const GRAPH_BG = 'rgba(0, 0, 0, 0.35)';\nconst GRAPH_BAR = '#f60';\nconst GRAPH_MEDIAN = 'rgba(255, 255, 255, 0.5)';", '// Paint colors follow the host theme; timing data/scales are unchanged.'],
  ]);
  await patch('data-panel.ts', [
    ["rect.setAttribute('fill', 'rgba(255, 102, 0, 0.2)');", "rect.setAttribute('fill', 'color-mix(in srgb, var(--mo-primary) 20%, transparent)');"],
    ["rect.setAttribute('stroke', '#f60');", "rect.setAttribute('stroke', 'var(--mo-primary)');"],
  ]);
  await patch('progress.ts', [
    ['#F60 0%, #F60 ${progress}%', 'var(--mo-primary) 0%, var(--mo-primary) ${progress}%'],
  ]);
  await patch('settings-panel.ts', [
    ["const languageRow = new Container({\n            class: 'settings-panel-row'\n        });", "const languageRow = new Container({\n            class: 'settings-panel-row',\n            hidden: window.parent !== window\n        });"],
  ]);
}

// Map compiled PCUI and SuperSplat UI declarations after Sass resolves its
// compile-time colors. This leaves all original selector/state specificity intact.
// Color pickers and viewport tool/axis colors express model data and stay upstream.
export function adaptCompiledCss(css, parse, theme) {
  const colors = new Map(Object.entries({
    '#fff': 'foreground', '#ffffff': 'foreground', '#aaa': 'mutedForeground', '#b3aaac': 'mutedForeground',
    '#7c7678': 'mutedForeground', '#829193': 'mutedForeground', '#9ba1a3': 'mutedForeground', '#999': 'mutedForeground',
    '#333': 'card', '#202020': 'background', '#282828': 'muted', '#181818': 'sidebar', '#444': 'accent', '#555': 'accent',
    '#2c393c': 'muted', '#293538': 'muted', '#20292b': 'muted', '#505050': 'border', '#404040': 'border', '#242424': 'background',
    '#f60': 'primary', '#ff6600': 'primary', '#ff9900': 'primary', '#ffaf50': 'primary',
    '#fb222f': 'destructive', '#d34141': 'destructive', '#ff7777': 'destructive',
    '#7f7': 'primary',
    'rgb(100%, 12.6666666667%, 12.6666666667%)': 'destructive',
    'rgba(40, 40, 40, 0.7)': 'muted', 'rgba(40, 40, 40, 0.5)': 'accent', 'rgba(32, 32, 32, 0.7)': 'overlay',
    'rgba(51.6666666667%, 91.6666666667%, 51.6666666667%, 0.75)': 'primary',
    'rgba(170, 170, 170, 0.5)': 'mutedForeground',
    'rgb(17.8431372549%, 17.8431372549%, 17.8431372549%)': 'accent',
    'rgb(17.4117647059%, 17.4117647059%, 17.4117647059%)': 'accent',
    'rgb(92, 82, 79)': 'accent', 'rgb(66%, 26.4%, 0%)': 'accent',
  }));
  const document = parse(css);
  document.walkComments((comment) => { if (/sourceMappingURL=/.test(comment.text)) comment.remove(); });
  document.walkDecls((decl) => {
    const selector = decl.parent.selector ?? '';
    if (/tool-svg|color-picker|color-input|gradient|view-cube|picker-color.*(?:pick-rect|pick-hue|pick-alpha)/.test(selector)
      || /^(fill|stroke|background-image|filter|text-shadow)$/.test(decl.prop) || decl.value.includes('url(')) return;
    decl.value = decl.value.replace(/rgba?\([^)]*\)|#[a-f0-9]{3,8}\b|\b(?:white|black)\b/gi, (value) => {
      let key = colors.get(value.toLowerCase());
      if (/^(white|#fff|#ffffff)$/i.test(value) && /background/.test(decl.prop)) key = 'card';
      if (/^(black|#000|#000000)$/i.test(value)) key = /background/.test(decl.prop) ? 'background' : 'foreground';
      if (value === 'white') key = 'foreground';
      if (key) return `var(--mo-${key})`;
      const alpha = value.match(/^rgba\((255, 102, 0|255, 153, 0|255, 175, 80|255, 255, 255|0, 0, 0|170, 170, 170), ([\d.]+)\)$/i);
      if (!alpha) return value;
      const role = alpha[1].startsWith('255, 1') ? 'primary' : alpha[1] === '0, 0, 0' ? 'foreground' : 'mutedForeground';
      return `color-mix(in srgb, var(--mo-${role}) ${Number(alpha[2]) * 100}%, transparent)`;
    });
  });
  const variables = (values) => Object.entries(values).map(([key, value]) => `  --mo-${key}: ${value};`).join('\n');
  return `/* MetOrigin Jan UI adaptation, theme ${theme.version}. */\n:root {\n${variables(theme.light)}\n}\n:root[data-theme="dark"] {\n${variables(theme.dark)}\n}\n${document.toString()}`;
}

export async function finishThemeAssets(integration, source, prepared) {
  const root = resolve(integration, '../..');
  const theme = JSON.parse(await readFile(join(root, 'integrations/jan/theme.json'), 'utf8'));
  if (theme.version !== 'jan-v1') throw new Error('Unsupported shared Jan theme version.');
  const parse = createRequire(join(source, 'package.json'))('postcss').parse;
  const cssPath = join(prepared, 'index.css');
  const css = adaptCompiledCss(await readFile(cssPath, 'utf8'), parse, theme);
  const styled = parse(css, { from: 'supersplat-ui.css' });
  styled.append(parse(await readFile(join(integration, 'ui-theme/controls.css'), 'utf8'), { from: 'metorigin-controls.css' }));
  const result = styled.toResult({ to: 'index.css', map: { inline: false, annotation: 'index.css.map', sourcesContent: true } });
  await writeFile(cssPath, result.css);
  await writeFile(join(prepared, 'index.css.map'), result.map.toString());
  const fonts = join(prepared, 'theme-fonts');
  await mkdir(fonts, { recursive: true });
  let notices = '';
  for (const [input, name] of [['integrations/jan/upstream/LICENSE', 'JAN-LICENSE.txt'], ['integrations/jan/licenses/Apache-2.0.txt', 'APACHE-2.0.txt']]) {
    const bytes = await readFile(join(root, input));
    await writeFile(join(prepared, name), bytes);
    notices += `\n=== Jan / Menlo Research: ${name} ===\n${bytes.toString('utf8')}\n`;
  }
  for (const [pkg, input, output] of fontInputs) {
    const directory = join(root, 'apps/desktop/node_modules', pkg);
    await cp(join(directory, input), join(fonts, output));
    const license = await readFile(join(directory, 'LICENSE'), 'utf8');
    await writeFile(join(fonts, `${output}.LICENSE`), license);
    notices += `\n=== ${pkg} (SIL OFL 1.1) ===\n${license}\n`;
  }
  await writeFile(join(prepared, 'ui-theme.json'), JSON.stringify({ version: theme.version, inputs: await themeInputs(integration) }, null, 2) + '\n');
  return notices;
}
