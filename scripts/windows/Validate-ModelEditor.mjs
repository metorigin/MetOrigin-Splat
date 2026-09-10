import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { connectPreviewTest } from './PreviewTestCdp.mjs';

const original = process.argv[2];
if (!original) throw new Error('Usage: node scripts/windows/Validate-ModelEditor.mjs <completed-project-path>');
const port = Number(process.env.METORIGIN_TAURI_DEBUG_PORT ?? 9258);
const output = resolve('target/editor-evidence', `run-${Date.now()}`);
const projectPath = join(output, '编辑验证.splat-project');
const projectId = randomUUID();
await mkdir(join(projectPath, 'output'), { recursive: true });
const project = JSON.parse(await readFile(join(original, 'project.json'), 'utf8'));
await writeFile(join(projectPath, 'project.json'), JSON.stringify({ ...project, id: projectId, name: 'SuperSplat 编辑验证', status: 'completed' }));
await copyFile(join(original, 'output/scene.ply'), join(projectPath, 'output/scene.ply'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const originalHash = hash(await readFile(join(projectPath, 'output/scene.ply')));
const inputHash = hash(await readFile(join(original, 'output/scene.ply')));
const checks = [];
const check = (name, passed, evidence) => {
  checks.push({ name, passed, evidence });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(evidence)}`);
  if (!passed) throw new Error(name);
};
const waitFor = async (predicate, timeout = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate(); if (result) return result;
    await new Promise((done) => setTimeout(done, 350));
  }
  throw new Error('Timed out waiting for model editor');
};
const main = await connectPreviewTest(port, (item) => !item.url.includes('model-editor'));
const editor = main;
const editorReady = () => editor.evaluate(`document.querySelector('.model-editor-actions button[aria-label="保存"]')?.disabled === false && !document.querySelector('.model-editor-busy')`);
const buttonAppearance = `(button) => { const style=getComputedStyle(button); return Object.fromEntries(['backgroundColor','color','borderColor','borderWidth','borderRadius','fontSize','fontWeight','padding','boxShadow'].map(key=>[key,style[key]])); }`;
const invoke = (command, args) => main.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
try {
  await main.evaluate(`localStorage.setItem('metorigin.ui.theme','dark');window.dispatchEvent(new Event('metorigin-theme-change'))`);
  const source = await invoke('get_gaussian_preview', { projectId, projectPath });
  await main.evaluate(`window.__editorSaveEvents = []; window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event:'model-edit-saved', target:{kind:'Any'}, handler:window.__TAURI_INTERNALS__.transformCallback(e => window.__editorSaveEvents.push(e.payload)) })`);
  await main.evaluate(`window.__editorOriginalFetch=window.fetch;window.fetch=(url,...args)=>String(url).includes('plugin%3Adialog%7Copen')?Promise.resolve(new Response(JSON.stringify(${JSON.stringify(projectPath)}),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}})):window.__editorOriginalFetch(url,...args);Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='打开项目').click()`);
  await waitFor(() => main.evaluate(`document.querySelector('h1')?.textContent==='SuperSplat 编辑验证' && Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='编辑')`));
  await main.evaluate(`window.fetch=window.__editorOriginalFetch`);
  check('completed-edit-entry', await main.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='编辑').previousElementSibling.textContent.includes('已完成')`), {});
  const actionSize = await main.evaluate(`(() => {const edit=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='编辑'),other=document.querySelector('.run-actions .project-action-menu > button'),a=edit.getBoundingClientRect(),b=other.getBoundingClientRect();return {width:a.width,height:a.height,otherWidth:b.width,otherHeight:b.height,icon:!!edit.querySelector('svg')}})()`);
  check('edit-action-matches-neighbor-size-and-icon', Math.abs(actionSize.width-actionSize.otherWidth)<1 && Math.abs(actionSize.height-actionSize.otherHeight)<1 && actionSize.icon, actionSize);
  const actionStyles = await main.evaluate(`Array.from(document.querySelectorAll('.run-actions .workspace-compact-action, .run-actions .project-action-menu > button')).map(${buttonAppearance})`);
  check('edit-action-matches-neighbor-style', actionStyles.length===2 && JSON.stringify(actionStyles[0])===JSON.stringify(actionStyles[1]), actionStyles);
  check('no-result-preview-heading', await main.evaluate(`!document.querySelector('.preview-panel > .panel-title')`), {});
  check('no-history-controls', await main.evaluate(`!document.querySelector('.model-editing-controls')&&!document.querySelector('select[aria-label="模型版本"]')&&!document.body.textContent.includes('查看训练原始版')`), {});
  await waitFor(() => main.evaluate(`document.querySelector('.gaussian-preview-label')?.textContent.includes(${JSON.stringify(source.vertex_count.toLocaleString('en-US'))})`));
  await main.screenshot(join(output, 'completed-results.png'));
  // Delay only the editor's model read to observe the real loading state.
  await main.evaluate(`window.fetch=(url,...args)=>String(url).includes('/read_gaussian_ply')?new Promise(resolve=>{window.__releaseEditorModel=()=>resolve(window.__editorOriginalFetch(url,...args));}):window.__editorOriginalFetch(url,...args)`);
  await main.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='编辑').click()`);
  await waitFor(() => editor.evaluate(`typeof window.__releaseEditorModel==='function'`));
  const loading = await editor.evaluate(`(() => {const overlay=document.querySelector('.model-editor-busy'),icon=overlay?.querySelector('svg'),style=icon&&getComputedStyle(icon);return {text:overlay?.textContent,animation:style?.animationName,duration:style?.animationDuration,statusRows:document.querySelectorAll('.model-editor-page > .model-editor-status').length};})()`);
  check('loading-copy-and-animation', loading.text==='正在载入' && loading.animation==='spin' && parseFloat(loading.duration)>0 && loading.statusRows===0, loading);
  await editor.screenshot(join(output, 'editor-loading.png'));
  await main.evaluate(`window.__releaseEditorModel();window.fetch=window.__editorOriginalFetch`);
  await waitFor(editorReady);
  const loaded = await editor.evaluate(`(() => {const w=document.querySelector('iframe').contentWindow; return { count:w.scene.events.invoke('scene.splats')[0].numSplats, gpu:w.scene.app.graphicsDevice.deviceType, error:document.querySelector('[role=alert]')?.textContent};})()`);
  check('native-WebGPU-import', loaded.count === source.vertex_count && !loaded.error, loaded);
  const layout = await editor.evaluate(`({width:document.querySelector('iframe').getBoundingClientRect().width,height:document.querySelector('iframe').getBoundingClientRect().height,workspaceWidth:document.querySelector('.workspace-content').clientWidth,windowHeight:innerHeight,sidebar:!!document.querySelector('.project-sidebar'),progress:!!document.querySelector('.run-summary-row')})`);
  check('editor-fills-workspace', layout.width >= layout.workspaceWidth * 0.95 && layout.height >= layout.windowHeight * 0.6 && layout.sidebar && !layout.progress, layout);
  check('no-project-header-or-editor-footer', await editor.evaluate(`!document.querySelector('.title-run-bar')&&!document.querySelector('.model-editor-footer')`), {});
  check('no-loaded-message-or-status-row', await editor.evaluate(`!document.querySelector('.model-editor-status')&&!document.body.textContent.includes('模型已载入')&&document.querySelector('.model-editor-header').nextElementSibling.classList.contains('model-editor-content')`), {});
  const controls = await editor.evaluate(`Array.from(document.querySelectorAll('.model-editor-actions button')).map(b=>({label:b.textContent,icon:!!b.querySelector('svg'),width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))`);
  check('back-save-order-icons-and-consistent-size', controls.length===2&&controls[0].label==='返回'&&controls[1].label==='保存'&&controls.every(b=>b.icon&&Math.abs(b.width-actionSize.width)<1&&Math.abs(b.height-actionSize.height)<1), controls);
  const editorStyles = await editor.evaluate(`Array.from(document.querySelectorAll('.model-editor-actions button')).map(${buttonAppearance})`);
  check('back-save-consistent-style', editorStyles.length===2&&JSON.stringify(editorStyles[0])===JSON.stringify(editorStyles[1])&&JSON.stringify(editorStyles[0])===JSON.stringify(actionStyles[0]), editorStyles);
  await editor.screenshot(join(output, 'editor-loaded.png'));
  // The same mask/select and delete commands used by SuperSplat's editing UI.
  const removed = await editor.evaluate(`(async () => {const w=document.querySelector('iframe').contentWindow, e=w.scene.events, splat=e.invoke('scene.splats')[0]; const n=Math.min(100, Math.floor(splat.numSplats/10)); const mask=new w.Uint8Array(splat.numSplats); mask.fill(255,0,n); e.fire('selection',splat); e.fire('select.mask','set',mask); await e.invoke('queue',()=>{}); const selected=splat.numSelected; e.fire('select.delete'); await e.invoke('queue',()=>{}); return {selected,remaining:splat.numSplats,dirty:e.invoke('scene.dirty')};})()`);
  check('delete-selected-Gaussians', removed.selected > 0 && removed.remaining === source.vertex_count - removed.selected && removed.dirty, removed);
  // Exercise the close guard with a cancelled native confirmation, without
  // leaving an unattended OS modal on the developer's desktop.
  await editor.evaluate(`window.__closeConfirmations=0;window.fetch=(url,...args)=>String(url).includes('plugin%3Adialog%7Cmessage')?(window.__closeConfirmations++,Promise.resolve(new Response(JSON.stringify('继续编辑'),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}}))):window.__editorOriginalFetch(url,...args);Array.from(document.querySelectorAll('.model-editor-actions button')).find(b=>b.textContent==='返回').click()`);
  await waitFor(() => editor.evaluate('window.__closeConfirmations===1'));
  check('cancel-close-preserves-edits', await editor.evaluate(`document.querySelector('iframe').contentWindow.scene.events.invoke('scene.dirty')`), {});
  await editor.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='项目中心').click()`);
  await waitFor(() => editor.evaluate('window.__closeConfirmations===2'));
  check('cancel-sidebar-navigation-preserves-edits', await editor.evaluate(`document.querySelector('iframe').contentWindow.scene.events.invoke('scene.dirty')`), {});
  await editor.evaluate(`window.fetch=window.__editorOriginalFetch`);
  await editor.evaluate(`window.fetch=(url,...args)=>String(url).includes('/save_edited_ply')?new Promise(resolve=>{window.__failSave=()=>resolve(new Response(JSON.stringify('模拟磁盘保存失败'),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}}));}):window.__editorOriginalFetch(url,...args);Array.from(document.querySelectorAll('.model-editor-actions button')).find(b=>b.textContent==='保存').click()`);
  await waitFor(() => editor.evaluate(`typeof window.__failSave==='function'`));
  await editor.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='项目中心').click()`);
  check('saving-blocks-navigation', await editor.evaluate(`!!document.querySelector('iframe') && Array.from(document.querySelectorAll('.model-editor-actions button')).every(b=>b.disabled)`), {});
  await editor.evaluate(`window.__failSave()`);
  await waitFor(() => editor.evaluate(`document.querySelector('[role=alert]')?.textContent.includes('保存未完成')`));
  check('failed-save-preserves-dirty-state', await editor.evaluate(`document.querySelector('iframe').contentWindow.scene.events.invoke('scene.dirty')`), {});
  check('failed-save-preserves-original-file', hash(await readFile(join(projectPath, 'output/scene.ply')))===originalHash, {});
  await editor.evaluate(`window.fetch=window.__editorOriginalFetch`);
  await editor.evaluate(`Array.from(document.querySelectorAll('.model-editor-actions button')).find(b=>b.textContent==='保存').click()`);
  await waitFor(() => editor.evaluate(`document.querySelector('.model-editor-status')?.textContent.includes('模型已保存')`));
  const saved = await invoke('get_gaussian_preview', { projectId, projectPath });
  check('overwrites-original-PLY', saved.relative_path==='output/scene.ply'&&saved.vertex_count===removed.remaining&&hash(await readFile(join(projectPath, 'output/scene.ply')))!==originalHash, saved);
  // Save again in the same session: the backend must advance its revision.
  await editor.evaluate(`Array.from(document.querySelectorAll('.model-editor-actions button')).find(b=>b.textContent==='保存').click()`);
  await waitFor(() => main.evaluate('window.__editorSaveEvents.length===2'));
  await waitFor(() => editor.evaluate(`document.querySelector('.model-editor-status')?.textContent.includes('模型已保存')`));
  check('repeat-save-in-same-session', (await invoke('get_gaussian_preview', { projectId, projectPath })).vertex_count===removed.remaining, {});
  const files = await readdir(join(projectPath, 'output'));
  check('no-history-or-temporary-files', files.length===1&&files[0]==='scene.ply', files);
  check('quality-count-updates-with-model', (await invoke('get_project_artifacts', { projectPath })).splat_count===removed.remaining, {});
  check('preview-update-event', await main.evaluate('window.__editorSaveEvents.length') === 2, await main.evaluate('window.__editorSaveEvents'));
  check('saved-state-clean', !await editor.evaluate(`document.querySelector('iframe').contentWindow.scene.events.invoke('scene.dirty')`), {});
  await editor.screenshot(join(output, 'editor-saved.png'));
  await editor.evaluate(`Array.from(document.querySelectorAll('.model-editor-actions button')).find(b=>b.textContent==='返回').click()`);
  await waitFor(() => main.evaluate(`!document.querySelector('iframe') && !!document.querySelector('.run-summary-row')`));
  await waitFor(() => main.evaluate(`document.querySelector('.gaussian-preview-label')?.textContent.includes(${JSON.stringify(removed.remaining.toLocaleString('en-US'))})`));
  check('returned-preview-renders-edited-count', true, removed.remaining);
  await main.screenshot(join(output, 'returned-results.png'));
  await main.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='编辑').click()`);
  await waitFor(editorReady);
  const count = await editor.evaluate(`document.querySelector('iframe').contentWindow.scene.events.invoke('scene.splats')[0].numSplats`);
  check('reopen-overwritten-model', count === removed.remaining, count);
  const stale = await main.evaluate(`window.__TAURI_INTERNALS__.invoke('save_edited_ply',new Uint8Array([1]),{headers:{'x-editor-session':'expired-session'}}).then(()=>false,error=>String(error).includes('编辑会话已失效'))`);
  check('reject-stale-session-save', stale, {});
  await editor.screenshot(join(output, 'editor-reopened.png'));
  await editor.evaluate(`Array.from(document.querySelectorAll('.model-editor-actions button')).find(b=>b.textContent==='返回').click()`);
  await waitFor(() => main.evaluate(`!document.querySelector('iframe')`));
} finally {
  check('input-fixture-unchanged', hash(await readFile(join(original, 'output/scene.ply')))===inputHash, {});
  await invoke('remove_recent_project', { projectId, projectPath }).catch((error) => console.error('Recent-index cleanup:', error));
  await writeFile(join(output, 'validation.json'), JSON.stringify({ checks, projectPath }, null, 2));
  console.log(`Evidence: ${output}`);
  main.close();
}
