// Compiled inside the pinned SuperSplat source tree by prepare.mjs.
import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { Vec3 } from 'playcanvas';
import { Events } from './events';
import { Scene } from './scene';
import { writeSplatFile } from './splat-serialize';
import { i18n } from './ui/localization';
import { applyEditorTheme, createEditorLanguageOwner } from './ui/metorigin-theme';

const CHANNEL = 'metorigin-supersplat-v1';
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

export const registerMetOriginBridge = (events: Events, scene: Scene) => {
    if (window.parent === window) return;
    const origin = window.location.origin;
    const languageOwner = createEditorLanguageOwner(i18n.setLanguage.bind(i18n), true);
    i18n.setLanguage = languageOwner.fromEditor;
    let busy = false;
    let pendingSave: string | null = null;
    let nativeImageSave = false;
    const themeRequests = new Set<string>();
    const imageReplies = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer?: number }>();
    const requestImage = (command: 'begin' | 'save' | 'end', data: { exportId: string; format: string; bytes?: ArrayBuffer }) => {
        const id = crypto.randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            // A native save dialog is a user interaction, not a timed background
            // task. Keep it pending until the user saves/cancels; timing it out
            // would falsely release the editor while a later write is possible.
            const timer = command === 'save' ? undefined : window.setTimeout(() => {
                imageReplies.delete(id);
                reject(new Error('图像保存通信超时。'));
            }, 5000);
            imageReplies.set(id, { resolve, reject, timer });
            try {
                window.parent.postMessage({ channel: CHANNEL, kind: 'image-export', id, command, data }, origin, data.bytes ? [data.bytes] : []);
            } catch (error) {
                imageReplies.delete(id);
                window.clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    };
    const renderImage = events.functions.get('render.image');
    if (!renderImage) throw new Error('Pinned image renderer is unavailable.');
    events.functions.set('render.image', async (settings: { format?: unknown }, fileStream?: unknown) => {
        // Leave standalone/caller-owned file streams unchanged. The handshake
        // enables this adapter only when the embedding host implements saving.
        if (!nativeImageSave || fileStream) return renderImage(settings, fileStream);
        const format = settings?.format;
        if (format !== 'png' && format !== 'jpeg' && format !== 'webp') throw new Error('不支持的图像格式。');
        if (busy || pendingSave) throw new Error('编辑器正在处理，请稍候。');
        busy = true;
        const exportId = crypto.randomUUID();
        let bytes: ArrayBuffer | null = null;
        let wrote = false;
        let closeResult: Promise<void> | undefined;
        let endResult: Promise<unknown> | undefined;
        let restoreRendering: (() => void) | undefined;
        let cancelled = false;
        const endImage = () => {
            if (!endResult) endResult = requestImage('end', { exportId, format });
            return endResult;
        };
        const sink = {
            write: async (value: Uint8Array) => {
                if (wrote || closeResult || !(value instanceof Uint8Array) || !value.byteLength || value.byteLength > MAX_IMAGE_BYTES) {
                    throw new Error('图像数据无效或超过 256 MiB 上限。');
                }
                // Copy only the view, not unrelated bytes in its backing buffer.
                bytes = new Uint8Array(value).buffer;
                wrote = true;
            },
            close: () => {
                if (!closeResult) closeResult = (async () => {
                    // Upstream closes again on failure, including before any
                    // encoded bytes exist. Never open a dialog or save empty data.
                    const output = bytes;
                    bytes = null;
                    if (!output) { await endImage(); return; }
                    try {
                        const result = await requestImage('save', { exportId, format, bytes: output });
                        if (result !== null && typeof result !== 'string') throw new Error('图像保存响应无效。');
                        cancelled = result === null;
                    } catch (error) {
                        // The pinned renderer awaits its error popup before it
                        // returns. Remove the parent's iframe-blocking overlay
                        // first, otherwise that popup cannot be dismissed.
                        await endImage();
                        throw error;
                    }
                })();
                return closeResult;
            }
        };
        try {
            await requestImage('begin', { exportId, format });
            const lockedRenderMode = scene.lockedRenderMode;
            const lockedRender = scene.lockedRender;
            // Locked captures use the sorted, blended path regardless of the
            // user's stochastic viewport preference. onUpdate fires 'update'
            // before consuming lockedRender, while render.image requests each
            // standard/cube-face frame through forceRender instead.
            const update = events.on('update', () => {
                if (scene.forceRender) scene.lockedRender = true;
            });
            scene.lockedRenderMode = true;
            restoreRendering = () => {
                update.off();
                scene.lockedRenderMode = lockedRenderMode;
                scene.lockedRender = lockedRender;
            };
            const result = await renderImage(settings, sink);
            return result && !cancelled;
        } finally {
            bytes = null;
            try { restoreRendering?.(); }
            finally {
                try { await endImage(); }
                finally { busy = false; }
            }
        }
    });
    const send = (id: string, result: unknown, transfer: Transferable[] = []) => {
        window.parent.postMessage({ channel: CHANNEL, id, result }, origin, transfer);
    };
    window.addEventListener('message', async (event: MessageEvent) => {
        if (event.source !== window.parent || event.origin !== origin || event.data?.channel !== CHANNEL) return;
        if (event.data.kind === 'image-export-reply') {
            const reply = imageReplies.get(event.data.id);
            if (!reply) return;
            imageReplies.delete(event.data.id);
            window.clearTimeout(reply.timer);
            if (typeof event.data.error === 'string') reply.reject(new Error(event.data.error));
            else reply.resolve(event.data.result);
            return;
        }
        if (event.data.kind !== undefined) return;
        const { id, command, data } = event.data;
        if (typeof id !== 'string') return;
        let acquired = false;
        try {
            if (command === 'ping') {
                if (data?.nativeImageSave === true) nativeImageSave = true;
                send(id, true);
                return;
            }
            if (command === 'language') {
                await languageOwner.fromHost(data);
                document.documentElement.lang = data.locale === 'en-US' ? 'en' : data.locale;
                send(id, true);
                return;
            }
            if (command === 'theme') {
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid theme request ID.');
                if (themeRequests.has(id.toLowerCase())) throw new Error('Duplicate theme request.');
                themeRequests.add(id.toLowerCase());
                send(id, applyEditorTheme(data));
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
                const imported = await events.invoke('import', [{ filename: file.name, contents: file }]);
                if (events.invoke('scene.empty')) throw new Error('模型加载失败，未找到可编辑的高斯。');
                // Resolve lazy scene bounds before fitting the fresh editor's camera.
                scene.camera.focus();
                const forward = data?.camera?.forward;
                const model = Array.isArray(imported) && imported.length === 1 ? imported[0] : null;
                if (Array.isArray(forward) && forward.length === 3 && forward.every(Number.isFinite)
                    && typeof model?.entity?.getWorldTransform === 'function') {
                    const length = Math.hypot(...forward);
                    if (Number.isFinite(length) && length > 0) {
                        const direction = new Vec3(forward[0] / length, forward[1] / length, forward[2] / length);
                        // PLY coordinates become editor world coordinates through the actual import transform.
                        // transformVector excludes translation; the current geometry supplies the fit position.
                        model.entity.getWorldTransform().transformVector(direction, direction);
                        const worldLength = Math.hypot(direction.x, direction.y, direction.z);
                        if (Number.isFinite(worldLength) && worldLength > 0) {
                            // Normal orbit/fly controls support yaw/pitch with world-Y up, not capture roll.
                            scene.camera.setAzimElev(
                                Math.atan2(-direction.x, -direction.z) * 180 / Math.PI,
                                Math.asin(Math.max(-1, Math.min(1, direction.y / worldLength))) * 180 / Math.PI,
                                0
                            );
                        }
                    }
                }
                events.fire('doc.saved');
                send(id, true);
            } else if (command === 'export') {
                // Use the command queue so pending GPU edits finish before export.
                // Parent blocks interaction until persistence is acknowledged.
                const fs = new MemoryFileSystem();
                await events.invoke('queue', async () => {
                    const splats = events.invoke('scene.splats');
                    if (!splats.length) throw new Error('没有可保存的高斯模型。');
                    // SuperSplat 3.7's shBands explicitly pads to that band count.
                    // Omit it to preserve the model's actual SH0/SH1/SH3 data.
                    await writeSplatFile(splats, {}, 'ply', 'scene.ply', {}, fs);
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
