// UI paint only. These colors never enter scene materials, selection masks or exports.
export const EDITOR_THEME_VERSION = 'jan-v1';
export type EditorTheme = 'light' | 'dark';

// Embedded preferences/reset may never override the host's language choice.
// Capture the original setter once; standalone callers retain upstream behavior.
export const createEditorLanguageOwner = (
    setLanguage: (locale: string | null) => Promise<unknown>,
    embedded = window.parent !== window
) => ({
    fromEditor: (locale: string | null) => embedded ? Promise.resolve(undefined) : setLanguage(locale),
    fromHost: (data: unknown) => {
        const value = data as { locale?: unknown } | null;
        if (!value || (value.locale !== 'en' && value.locale !== 'en-US' && value.locale !== 'zh-CN')) {
            throw new Error('Unsupported editor language.');
        }
        const locale = value.locale === 'en-US' ? 'en' : value.locale;
        return setLanguage(locale);
    }
});

const fallback = { background: '#ffffff', primary: '#be4c30', muted: '#737373', foreground: '#262626' };
let paint = { ...fallback };
let revision = 0;
export const uiPaint = () => paint;
export const uiPaintRevision = () => revision;
export const uiPixel = (hex: string) => {
    const value = Number.parseInt(hex.slice(1), 16);
    // ImageData's Uint32 view uses the browser's native little-endian byte order.
    return (0xff000000 | ((value & 255) << 16) | (value & 0xff00) | ((value >>> 16) & 255)) >>> 0;
};

export const applyEditorTheme = (data: unknown) => {
    const value = data as { theme?: unknown; version?: unknown } | null;
    if (!value || (value.theme !== 'light' && value.theme !== 'dark') || value.version !== EDITOR_THEME_VERSION) {
        throw new Error('Unsupported editor theme or theme version.');
    }
    if (document.documentElement.dataset.theme === value.theme && revision > 0) return true;
    document.documentElement.dataset.theme = value.theme;
    document.documentElement.style.colorScheme = value.theme;
    const style = getComputedStyle(document.documentElement);
    const color = (key: string, defaultValue: string) => {
        const result = style.getPropertyValue(`--mo-${key}`).trim();
        return /^#[0-9a-f]{6}$/i.test(result) ? result : defaultValue;
    };
    paint = { background: color('card', fallback.background), primary: color('primary', fallback.primary),
        muted: color('mutedForeground', fallback.muted), foreground: color('foreground', fallback.foreground) };
    revision++;
    window.dispatchEvent(new Event('metorigin-ui-theme'));
    return true;
};
