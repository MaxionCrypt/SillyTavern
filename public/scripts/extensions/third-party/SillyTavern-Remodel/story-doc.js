import { getContext } from '../../../st-context.js';
import { buildStoryArchiveCatchUpPreview, hashStoryArchiveText, rebaseStoryArchiveProvenance } from './story-archive-provenance.js';

// StoryDoc: the data model for the redesigned Story mode — a real, standalone
// document, NOT a hidden chat. A story Scene in the timeline binds to a
// StoryDoc id (instead of a linkedChat), and the document owns its own prose,
// authorial guidance, and character binding. Persisted in the same
// extensionSettings.remodel namespace / saveSettingsDebounced discipline the
// timeline store uses, under its own storyDocsV1 key.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyDocsV1';
const STORE_VERSION = 5;
const STORY_ARCHIVE_CAPTURE_STATUSES = Object.freeze(['pending', 'processing', 'applied', 'failed', 'superseded']);

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
        // Monotonic manuscript revision used by Archive provenance. Formatting,
        // guidance and other document metadata do not advance it.
        bodyRevision: 0,
        // Exact accepted manuscript spans waiting for, or already processed by,
        // the shared Timeline Loom Archive. This is provenance and retry state,
        // not a second Archive.
        archiveCaptures: [],
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
        if (doc.body !== patch.body) {
            rebaseStoryArchiveProvenance(doc.archiveCaptures, doc.body, patch.body);
            doc.body = patch.body;
            doc.bodyRevision += 1;
        }
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

/** Queue one exact accepted manuscript span for the shared Loom Archive. */
export function createStoryArchiveCapture(docId, input = {}) {
    const store = getStore();
    const doc = store.docs[docId];
    const changeType = ['addition', 'edit', 'deletion'].includes(input.changeType) ? input.changeType : 'addition';
    const beforeText = String(input.beforeText || '');
    const text = String(input.text ?? input.afterText ?? '').trim();
    if (!doc || (!text && !beforeText)) return null;
    const origin = input.origin === 'user' ? 'user' : 'story-narrator';
    const generationId = String(input.generationId || '');
    const beatId = input.beatId == null ? null : String(input.beatId);
    const contentHash = hashText(`${changeType}\n${beforeText}\n${text}`);
    const stableKey = String(input.stableKey || (generationId
        ? `${origin}:${generationId}:${beatId || ''}`
        : `${origin}:${doc.bodyRevision}:${contentHash}`));
    const existing = doc.archiveCaptures.find((capture) => capture.stableKey === stableKey);
    if (existing) return existing;

    if (beatId) {
        for (const capture of doc.archiveCaptures) {
            if (capture.beatId === beatId && capture.status !== 'superseded') {
                capture.status = 'superseded';
                capture.supersededAt = now();
                capture.updatedAt = capture.supersededAt;
            }
        }
    }

    const timestamp = now();
    const start = Math.max(0, Math.min(doc.body.length, Number(input.start) || 0));
    const end = Math.max(start, Math.min(doc.body.length, Number(input.end) || start + text.length));
    const capture = {
        id: createId('story-capture'),
        stableKey,
        origin,
        text,
        contentHash,
        start,
        end,
        bodyRevision: doc.bodyRevision,
        generationId,
        beatId,
        changeType,
        beforeText,
        supersedesCaptureIds: Array.isArray(input.supersedesCaptureIds) ? input.supersedesCaptureIds.map(String) : [],
        sourceStatus: 'current',
        currentText: '',
        status: 'pending',
        attempts: 0,
        transactionId: null,
        worldSenseReceiptId: null,
        livingLorePacket: null,
        loreProposals: [],
        loreProposalRejections: [],
        loreProposalIds: [],
        archiveFacts: [],
        error: '',
        createdAt: timestamp,
        updatedAt: timestamp,
        appliedAt: null,
        supersededAt: null,
    };
    doc.archiveCaptures.push(capture);
    doc.updatedAt = timestamp;
    saveStoryDocStore();
    return capture;
}

export function previewStoryArchiveCatchUp(docId) {
    const doc = getStoryDoc(docId);
    return doc ? buildStoryArchiveCatchUpPreview(doc) : null;
}

export function supersedeStoryArchiveCaptures(docId, captureIds, supersededBy = null) {
    const store = getStore();
    const doc = store.docs[docId];
    const ids = new Set((captureIds || []).map(String));
    if (!doc || !ids.size) return [];
    const timestamp = now();
    const changed = [];
    for (const capture of doc.archiveCaptures || []) {
        if (!ids.has(capture.id) || capture.status === 'superseded') continue;
        capture.status = 'superseded';
        capture.supersededAt = timestamp;
        capture.supersededBy = supersededBy == null ? null : String(supersededBy);
        capture.updatedAt = timestamp;
        changed.push(capture);
    }
    if (changed.length) {
        doc.updatedAt = timestamp;
        saveStoryDocStore();
    }
    return changed;
}

export function getStoryArchiveCapture(docId, captureId) {
    return getStoryDoc(docId)?.archiveCaptures?.find((capture) => capture.id === String(captureId || '')) || null;
}

export function listStoryArchiveCaptures(docId, { statuses = null } = {}) {
    const captures = getStoryDoc(docId)?.archiveCaptures || [];
    const allowed = Array.isArray(statuses) ? new Set(statuses) : null;
    return captures.filter((capture) => !allowed || allowed.has(capture.status));
}

export function updateStoryArchiveCapture(docId, captureId, patch = {}) {
    const store = getStore();
    const doc = store.docs[docId];
    const capture = doc?.archiveCaptures?.find((item) => item.id === String(captureId || ''));
    if (!capture) return null;
    if (STORY_ARCHIVE_CAPTURE_STATUSES.includes(patch.status)) capture.status = patch.status;
    if (Number.isFinite(Number(patch.attempts))) capture.attempts = Math.max(0, Math.floor(Number(patch.attempts)));
    if ('transactionId' in patch) capture.transactionId = patch.transactionId == null ? null : String(patch.transactionId);
    if ('worldSenseReceiptId' in patch) capture.worldSenseReceiptId = patch.worldSenseReceiptId == null ? null : String(patch.worldSenseReceiptId);
    if ('livingLorePacket' in patch) capture.livingLorePacket = patch.livingLorePacket && typeof patch.livingLorePacket === 'object' ? structuredClone(patch.livingLorePacket) : null;
    if (Array.isArray(patch.loreProposals)) capture.loreProposals = structuredClone(patch.loreProposals);
    if (Array.isArray(patch.loreProposalRejections)) capture.loreProposalRejections = structuredClone(patch.loreProposalRejections);
    if (Array.isArray(patch.loreProposalIds)) capture.loreProposalIds = patch.loreProposalIds.map(String);
    if (Array.isArray(patch.archiveFacts)) capture.archiveFacts = patch.archiveFacts.map(String).filter(Boolean);
    if (typeof patch.error === 'string') capture.error = patch.error;
    if ('appliedAt' in patch) capture.appliedAt = patch.appliedAt || null;
    if ('supersededAt' in patch) capture.supersededAt = patch.supersededAt || null;
    capture.updatedAt = now();
    doc.updatedAt = capture.updatedAt;
    saveStoryDocStore();
    return capture;
}

export function supersedeStoryArchiveCapturesForBeat(docId, beatId) {
    const store = getStore();
    const doc = store.docs[docId];
    const id = String(beatId || '');
    if (!doc || !id) return [];
    const timestamp = now();
    const changed = [];
    for (const capture of doc.archiveCaptures || []) {
        if (capture.beatId !== id || capture.status === 'superseded') continue;
        capture.status = 'superseded';
        capture.supersededAt = timestamp;
        capture.updatedAt = timestamp;
        changed.push(capture);
    }
    if (changed.length) {
        doc.updatedAt = timestamp;
        saveStoryDocStore();
    }
    return changed;
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
        doc.bodyRevision = Math.max(0, Math.floor(Number(doc.bodyRevision) || 0));
        doc.archiveCaptures = Array.isArray(doc.archiveCaptures)
            ? doc.archiveCaptures.map(normalizeArchiveCapture).filter(Boolean)
            : [];
        for (const capture of doc.archiveCaptures) {
            if (capture.status === 'superseded' || capture.changeType === 'deletion') continue;
            if (doc.body.slice(capture.start, capture.end) === capture.text) continue;
            // V3 did not rebase capture offsets while the author edited. A
            // unique surviving source span is safe to relocate during the V4
            // migration; ambiguous or genuinely changed text stays dirty for
            // the owner's catch-up preview instead of being guessed.
            const first = capture.text ? doc.body.indexOf(capture.text) : -1;
            const unique = first >= 0 && doc.body.indexOf(capture.text, first + 1) < 0;
            if (unique) {
                capture.start = first;
                capture.end = first + capture.text.length;
                capture.sourceStatus = 'current';
                capture.currentText = '';
            } else {
                capture.sourceStatus = 'changed';
                capture.currentText = doc.body.slice(capture.start, capture.end);
            }
        }
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

function normalizeArchiveCapture(value) {
    if (!value || typeof value !== 'object' || !value.id
        || (!String(value.text || '').trim() && !String(value.beforeText || '').trim())) return null;
    const text = String(value.text).trim();
    const start = Math.max(0, Math.floor(Number(value.start) || 0));
    const end = Math.max(start, Math.floor(Number(value.end) || start + text.length));
    const status = STORY_ARCHIVE_CAPTURE_STATUSES.includes(value.status) ? value.status : 'pending';
    return {
        id: String(value.id),
        stableKey: String(value.stableKey || `${value.origin || 'story-narrator'}:${value.generationId || ''}:${hashText(text)}`),
        origin: value.origin === 'user' ? 'user' : 'story-narrator',
        text,
        contentHash: String(value.contentHash || hashText(text)),
        start,
        end,
        bodyRevision: Math.max(0, Math.floor(Number(value.bodyRevision) || 0)),
        generationId: String(value.generationId || ''),
        beatId: value.beatId == null ? null : String(value.beatId),
        changeType: ['addition', 'edit', 'deletion'].includes(value.changeType) ? value.changeType : 'addition',
        beforeText: String(value.beforeText || ''),
        supersedesCaptureIds: Array.isArray(value.supersedesCaptureIds) ? value.supersedesCaptureIds.map(String) : [],
        sourceStatus: value.sourceStatus === 'changed' ? 'changed' : 'current',
        currentText: String(value.currentText || ''),
        status,
        attempts: Math.max(0, Math.floor(Number(value.attempts) || 0)),
        transactionId: value.transactionId == null ? null : String(value.transactionId),
        worldSenseReceiptId: value.worldSenseReceiptId == null ? null : String(value.worldSenseReceiptId),
        livingLorePacket: value.livingLorePacket && typeof value.livingLorePacket === 'object' ? structuredClone(value.livingLorePacket) : null,
        loreProposals: Array.isArray(value.loreProposals) ? structuredClone(value.loreProposals) : [],
        loreProposalRejections: Array.isArray(value.loreProposalRejections) ? structuredClone(value.loreProposalRejections) : [],
        loreProposalIds: Array.isArray(value.loreProposalIds) ? value.loreProposalIds.map(String) : [],
        archiveFacts: Array.isArray(value.archiveFacts) ? value.archiveFacts.map(String).filter(Boolean) : [],
        error: String(value.error || ''),
        createdAt: value.createdAt || now(),
        updatedAt: value.updatedAt || value.createdAt || now(),
        appliedAt: value.appliedAt || null,
        supersededAt: value.supersededAt || null,
        supersededBy: value.supersededBy == null ? null : String(value.supersededBy),
    };
}

function hashText(value) {
    return hashStoryArchiveText(value);
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
