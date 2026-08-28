const STORAGE_KEY = 'sillytavern-remodel-ui-location-v1';
const VERSION = 1;
const TABS = new Set(['timeline', 'characters', 'prompts', 'personas', 'lorebooks', 'debug']);

function defaultLocation() {
    return {
        version: VERSION,
        currentWindow: { kind: 'native' },
        activeTavernTab: 'timeline',
        focusedTimelineId: null,
        codexOpen: false,
        archive: { open: false, sceneId: null, view: 'loom' },
        scroll: { key: '', top: 0 },
    };
}

function normalizeId(value) {
    const text = String(value || '').trim();
    return text ? text.slice(0, 240) : null;
}

function normalizeTab(value) {
    const tab = String(value || '').trim();
    return TABS.has(tab) ? tab : 'timeline';
}

export function normalizeUiLocation(value) {
    const fallback = defaultLocation();
    if (!value || typeof value !== 'object' || Number(value.version ?? VERSION) !== VERSION) return fallback;
    const tab = normalizeTab(value.activeTavernTab || value.currentWindow?.tab);
    const windowKind = value.currentWindow?.kind === 'tavern' ? 'tavern' : 'native';
    const archiveView = value.archive?.view === 'narrator' ? 'narrator' : 'loom';
    return {
        version: VERSION,
        currentWindow: windowKind === 'tavern' ? { kind: 'tavern', tab } : { kind: 'native' },
        activeTavernTab: tab,
        focusedTimelineId: normalizeId(value.focusedTimelineId),
        codexOpen: Boolean(value.codexOpen),
        archive: {
            open: Boolean(value.archive?.open),
            sceneId: normalizeId(value.archive?.sceneId),
            view: archiveView,
        },
        scroll: {
            key: String(value.scroll?.key || '').slice(0, 300),
            top: Math.max(0, Math.min(10_000_000, Number(value.scroll?.top) || 0)),
        },
    };
}

function defaultStorage() {
    try { return globalThis.sessionStorage || null; } catch { return null; }
}

export function loadUiLocation(storage = defaultStorage()) {
    if (!storage) return defaultLocation();
    try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
        return normalizeUiLocation(parsed);
    } catch {
        return defaultLocation();
    }
}

export function saveUiLocation(value, storage = defaultStorage()) {
    const normalized = normalizeUiLocation(value);
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* navigation persistence is best effort */ }
    return normalized;
}

export function clearUiLocation(storage = defaultStorage()) {
    try { storage?.removeItem(STORAGE_KEY); } catch { /* navigation persistence is best effort */ }
}

