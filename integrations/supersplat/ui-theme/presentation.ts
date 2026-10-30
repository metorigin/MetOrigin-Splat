// Apply the embedded editor's new defaults once, without resetting unrelated
// preferences or overriding choices made after this migration.
export const migrateEmbeddedOverlayDefaults = (
    embedded = window.parent !== window,
    storage?: Pick<Storage, 'getItem' | 'setItem'>
) => {
    if (!embedded) return;
    try {
        const target = storage ?? window.localStorage;
        const marker = 'metorigin:supersplat:overlay-defaults:v1';
        if (target.getItem(marker) === '1') return;
        const key = 'supersplat:preferences';
        const raw = target.getItem(key);
        const blob = raw === null ? { version: 1, values: {} } : JSON.parse(raw);
        if (blob?.version !== 1 || !blob.values || typeof blob.values !== 'object' || Array.isArray(blob.values)) return;
        blob.values['camera.showInfo'] = false;
        blob.values['view.perfOverlay'] = false;
        target.setItem(key, JSON.stringify(blob));
        // A failed write must remain retryable on the next editor startup.
        target.setItem(marker, '1');
    } catch {
        // Upstream handles corrupt/unavailable storage by using safe defaults.
    }
};
