import { getContext } from '../../../st-context.js';

// StoryDoc: the data model for the redesigned Story mode — a real, standalone
// document, NOT a hidden chat. A story Scene in the timeline binds to a
// StoryDoc id (instead of a linkedChat), and the document owns its own prose,
// authorial guidance, and character binding. Persisted in the same
// extensionSettings.remodel namespace / saveSettingsDebounced discipline the
// timeline store uses, under its own storyDocsV1 key.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyDocsV1';
const STORE_VERSION = 1;

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
        // Which character card's fields feed the generation context. Stored as
        // core's numeric character index (this_chid-style), same convention the
        // timeline scene bindings use.
        boundCharacterId: boundCharacterId == null ? null : String(boundCharacterId),
        // The prose. Plain text (paragraphs separated by blank lines); the
        // editor renders it and writes edits straight back here.
        body: '',
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
    if ('boundCharacterId' in patch) {
        doc.boundCharacterId = patch.boundCharacterId == null ? null : String(patch.boundCharacterId);
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
        doc.boundCharacterId = doc.boundCharacterId == null ? null : String(doc.boundCharacterId);
    }
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
