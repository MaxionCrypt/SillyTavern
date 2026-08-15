import { getContext } from '../../../st-context.js';

// StoryDoc: the data model for the redesigned Story mode — a real, standalone
// document, NOT a hidden chat. A story Scene in the timeline binds to a
// StoryDoc id (instead of a linkedChat), and the document owns its own prose,
// authorial guidance, and character binding. Persisted in the same
// extensionSettings.remodel namespace / saveSettingsDebounced discipline the
// timeline store uses, under its own storyDocsV1 key.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyDocsV1';
const STORE_VERSION = 2;

function getStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];

    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = createEmptyStore();
    }
    normalizeStore(namespace[SETTINGS_KEY]);
    return namespace[SETTINGS_KEY];
}

export function saveStoryDocStore() {
    getContext().saveSettingsDebounced();
}

// A StoryDoc is a single continuous document for now: one `body` of prose.
// (Multiple named scenes per doc is a later, optional stage — the shape here
// leaves room for it via an optional `scenes` array without needing a
// migration when it lands.)
export function createStoryDoc({ title = 'New Story', boundCharacterId = null } = {}) {
    const store = getStore();
    const doc = {
        id: createId('storydoc'),
        title: normalizeText(title, 'New Story'),
        // The authorial-guidance field: the document's OWN system-prompt-style
        // steering (tone, POV, constraints), injected at generation time. This
        // replaces the chat-scoped Author's Note, which a doc-only story has no
        // chat to carry.
        guidance: '',
        // Optional prose carried forward from another timeline scene. Kept on
        // the document so Story generation can consume it without chat macros.
        priorText: '',
        priorSceneId: null,
        beats: [],
        // Which character card's fields feed the generation context. Stored as
        // core's numeric character index (this_chid-style), same convention the
        // timeline scene bindings use.
        boundCharacterId: boundCharacterId == null ? null : String(boundCharacterId),
        // StoryDocs have no native chat_metadata, so this is their explicit
        // equivalent of a chat-bound lorebook. Global, persona, and character
        // lorebook associations remain live native sources.
        lorebookName: null,
        scanGuidanceForLore: false,
        worldInfoState: normalizeWorldInfoState(),
        // The prose. Plain text (paragraphs separated by blank lines); the
        // editor renders it and writes edits straight back here.
        body: '',
        // Inline formatting, kept OUT of `body` on purpose: a list of
        // {start,end} character ranges over `body` carrying the styles the
        // Manuscript format bar applied (font/size/bold/italic/underline).
        // Prose stays clean plain text, so nothing here ever leaks into a
        // generation prompt. Offsets are recomputed from the DOM on every
        // save (readStoryEditorState), which is what keeps them correct
        // while the author types.
        styleRuns: [],
        // Whole-manuscript typography, owned by THIS document rather than by
        // the browser: setting a face or a size on one story must not reach
        // any other scene (a roleplay scene least of all — it shares the
        // --remodel-manuscript-font variable). Empty means "the default".
        font: '',
        fontSize: '',
        createdAt: now(),
        updatedAt: now(),
    };
    store.docs[doc.id] = doc;
    store.docIds.push(doc.id);
    saveStoryDocStore();
    return doc;
}

export function getStoryDoc(docId) {
    if (!docId) {
        return null;
    }
    return getStore().docs[docId] || null;
}

export function getAllStoryDocs() {
    const store = getStore();
    return store.docIds.map((id) => store.docs[id]).filter(Boolean);
}

// Fixed-field allowlist patch — dynamic prose/guidance/title/binding only,
// never structural fields (id/createdAt), mirroring timeline-state's
// sanitize discipline.
export function updateStoryDoc(docId, patch) {
    const store = getStore();
    const doc = store.docs[docId];
    if (!doc) {
        return null;
    }
    if (typeof patch.title === 'string') {
        doc.title = normalizeText(patch.title, doc.title);
    }
    if (typeof patch.guidance === 'string') {
        doc.guidance = patch.guidance;
    }
    if (typeof patch.body === 'string') {
        doc.body = patch.body;
    }
    if (typeof patch.priorText === 'string') {
        doc.priorText = patch.priorText;
    }
    if ('priorSceneId' in patch) {
        doc.priorSceneId = patch.priorSceneId == null ? null : String(patch.priorSceneId);
    }
    if (Array.isArray(patch.beats)) {
        doc.beats = patch.beats.map(normalizeBeat).filter(Boolean);
    }
    if (Array.isArray(patch.styleRuns)) {
        doc.styleRuns = normalizeStyleRuns(patch.styleRuns);
    }
    if (typeof patch.font === 'string') {
        doc.font = patch.font;
    }
    if (typeof patch.fontSize === 'string') {
        doc.fontSize = patch.fontSize;
    }
    if ('boundCharacterId' in patch) {
        doc.boundCharacterId = patch.boundCharacterId == null ? null : String(patch.boundCharacterId);
    }
    if ('lorebookName' in patch) {
        doc.lorebookName = patch.lorebookName == null || patch.lorebookName === '' ? null : String(patch.lorebookName);
    }
    if ('scanGuidanceForLore' in patch) {
        doc.scanGuidanceForLore = Boolean(patch.scanGuidanceForLore);
    }
    if ('worldInfoState' in patch) {
        doc.worldInfoState = normalizeWorldInfoState(patch.worldInfoState);
    }
    doc.updatedAt = now();
    saveStoryDocStore();
    return doc;
}

export function deleteStoryDoc(docId) {
    const store = getStore();
    if (!store.docs[docId]) {
        return;
    }
    delete store.docs[docId];
    store.docIds = store.docIds.filter((id) => id !== docId);
    saveStoryDocStore();
}

// --- internals (mirror timeline-state.js) ---------------------------------

function createEmptyStore() {
    return {
        version: STORE_VERSION,
        docIds: [],
        docs: {},
    };
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.docIds));
}

function normalizeStore(store) {
    store.version = STORE_VERSION;
    store.docs ??= {};
    store.docIds = (store.docIds || []).filter((id) => store.docs[id]);
    for (const doc of Object.values(store.docs)) {
        doc.title ??= 'New Story';
        doc.guidance ??= '';
        doc.body ??= '';
        doc.priorText ??= '';
        doc.priorSceneId = doc.priorSceneId == null ? null : String(doc.priorSceneId);
        doc.beats = Array.isArray(doc.beats) ? doc.beats.map(normalizeBeat).filter(Boolean) : [];
        doc.styleRuns = normalizeStyleRuns(doc.styleRuns);
        doc.font = typeof doc.font === 'string' ? doc.font : '';
        doc.fontSize = typeof doc.fontSize === 'string' ? doc.fontSize : '';
        doc.boundCharacterId = doc.boundCharacterId == null ? null : String(doc.boundCharacterId);
        doc.lorebookName = doc.lorebookName == null || doc.lorebookName === '' ? null : String(doc.lorebookName);
        doc.scanGuidanceForLore = Boolean(doc.scanGuidanceForLore);
        doc.worldInfoState = normalizeWorldInfoState(doc.worldInfoState);
    }
}

function normalizeWorldInfoState(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const normalizeEffects = (effects) => {
        const result = {};
        if (!effects || typeof effects !== 'object') return result;
        for (const [key, effect] of Object.entries(effects)) {
            if (!effect || typeof effect !== 'object') continue;
            result[String(key)] = {
                hash: Number(effect.hash) || 0,
                end: Math.max(0, Number(effect.end) || 0),
            };
        }
        return result;
    };
    return {
        generationIndex: Math.max(0, Number(source.generationIndex) || 0),
        sticky: normalizeEffects(source.sticky),
        cooldown: normalizeEffects(source.cooldown),
    };
}

// A style run is only kept when it covers real characters AND actually
// carries a style — an empty run is indistinguishable from no run at all,
// so dropping them keeps the stored list from growing on every edit.
function normalizeStyleRuns(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(normalizeStyleRun).filter(Boolean).sort((a, b) => a.start - b.start);
}

function normalizeStyleRun(value) {
    if (!value || typeof value !== 'object') return null;
    const start = Math.max(0, Math.floor(Number(value.start) || 0));
    const end = Math.max(0, Math.floor(Number(value.end) || 0));
    if (end <= start) return null;
    const run = { start, end };
    if (value.font) run.font = String(value.font);
    if (value.size) run.size = String(value.size);
    if (value.bold) run.bold = true;
    if (value.italic) run.italic = true;
    if (value.underline) run.underline = true;
    return run.font || run.size || run.bold || run.italic || run.underline ? run : null;
}

function normalizeBeat(value) {
    if (!value || typeof value !== 'object' || !value.id) return null;
    return {
        id: String(value.id),
        instruction: String(value.instruction || ''),
        generatedText: String(value.generatedText || ''),
        position: Math.max(0, Number(value.position) || 0),
        hidden: Boolean(value.hidden),
        createdAt: value.createdAt || now(),
        updatedAt: value.updatedAt || now(),
    };
}

function normalizeText(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
}

function createId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${id}`;
}

function now() {
    return new Date().toISOString();
}
