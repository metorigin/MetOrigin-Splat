// Compiled inside the pinned SuperSplat source tree by prepare.mjs.
import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { Events } from './events';
import { writeSplatFile } from './splat-serialize';
import { i18n } from './ui/localization';

const CHANNEL = 'metorigin-supersplat-v1';

export const registerMetOriginBridge = (events: Events) => {
    if (window.parent === window) return;
    const origin = window.location.origin;
    let busy = false;
    let pendingSave: string | null = null;
    const send = (id: string, result: unknown, transfer: Transferable[] = []) => {
        window.parent.postMessage({ channel: CHANNEL, id, result }, origin, transfer);
    };
    window.addEventListener('message', async (event: MessageEvent) => {
        if (event.source !== window.parent || event.origin !== origin || event.data?.channel !== CHANNEL) return;
        const { id, command, data } = event.data;
        if (typeof id !== 'string') return;
        let acquired = false;
        try {
            if (command === 'ping') { send(id, true); return; }
            if (command === 'language') {
                if (data?.locale !== 'en' && data?.locale !== 'zh-CN') throw new Error('Unsupported language.');
                await i18n.setLanguage(data.locale);
                document.documentElement.lang = data.locale;
                send(id, true);
                return;
            }
            if (command === 'dirty') { send(id, busy || pendingSave !== null || events.invoke('scene.dirty')); return; }
            if (command === 'saved' || command === 'save-failed') {
                if (pendingSave !== data?.saveId) throw new Error('保存会话不匹配。');
                if (command === 'saved') events.fire('doc.saved');
                pendingSave = null;
                send(id, true);
                return;
            }
            if (busy || pendingSave) throw new Error('编辑器正在处理，请稍候。');
            busy = true;
            acquired = true;
            if (command === 'load') {
                if (!(data?.bytes instanceof ArrayBuffer)) throw new Error('模型数据无效。');
                const file = new File([data.bytes], 'scene.ply');
                await events.invoke('import', [{ filename: file.name, contents: file }]);
                if (events.invoke('scene.empty')) throw new Error('模型加载失败，未找到可编辑的高斯。');
                events.fire('doc.saved');
                send(id, true);
            } else if (command === 'export') {
                // Use the command queue so pending GPU edits finish before export.
                // Parent blocks interaction until persistence is acknowledged.
                const fs = new MemoryFileSystem();
                await events.invoke('queue', async () => {
                    const splats = events.invoke('scene.splats');
                    if (!splats.length) throw new Error('没有可保存的高斯模型。');
                    await writeSplatFile(splats, { maxSHBands: 3 }, 'ply', 'scene.ply', {}, fs);
                });
                const output = fs.results.get('scene.ply');
                if (!output?.byteLength) throw new Error('编辑结果为空。');
                if (output.byteLength > 1024 * 1024 * 1024) throw new Error('编辑结果超过 1 GiB 上限。');
                const bytes = output.slice().buffer;
                pendingSave = id;
                send(id, bytes, [bytes]);
            } else {
                throw new Error('未知编辑器操作。');
            }
        } catch (error) {
            window.parent.postMessage({ channel: CHANNEL, id, error: String(error) }, origin);
        } finally {
            if (acquired) busy = false;
        }
    });
};
