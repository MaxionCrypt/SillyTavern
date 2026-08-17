import {
    RETRIEVAL_MODES,
    VARIABLE_TYPES,
    attachEntry,
    computeVariable,
    createVariableValue,
    deleteVariableValue,
    detachEntry,
    formatVariable,
    getVariableValue,
    getVectorIndexState,
    listVariableEvents,
    listVariableValues,
    listVariablesForLoreRef,
    removeVariableModifier,
    updateVariableValue,
} from './variables-store.js';
import { entryKey } from './variables-lore-key.js';
import { listLoreBooks, listLoreEntries } from './variables-lore.js';
import { getLastVariableContext } from './variables-context.js';
import { ensureVariableVectorIndex } from './variables-vector.js';
import { getTimelineStore } from './timeline-state.js';

// The Variables authoring surface.
//
// One editor, mounted in two places: inside an expanded Lorebook entry, where
// the meaning a Variable refers to is already on screen, and in the Timeline
// State drawer, which is the only home for `always`-mode Variables that have no
// entry to hang off. Writing it once is the point — two editors over the same
// record drift, and this one has to agree with itself about types, bounds and
// retrieval settings.
//
// Rendering is string-based and re-entrant, matching the rest of the extension:
// a handler mutates the store, then asks for a re-render. Handlers return true
// when they claim an event, so the spine can chain them.

/**
 * View state, not document state. Everything here is about what the user is
 * looking at; nothing needs to survive a reload.
 */
const state = {
    pane: 'relevant',
    editingId: '',
    creating: false,
    creatingFor: null,
    pickerBook: '',
    pickerSearch: '',
    busy: '',
    notice: '',
    // Which mount is rendering right now. Set by each entry point and read by
    // canAuthor(); rendering is synchronous, so a module-level value is not a
    // race — it is the same shape `state` already has.
    context: 'readonly',
};

/**
 * Authoring lives in one place: the Codex.
 *
 * A Variable relates to many entries, so the entry is the wrong home for
 * editing it — attaching one value to ten of a hundred entries from inside an
 * entry means visiting ten of them. The lorebook section and the scene rails
 * are readouts; the Codex owns creation, editing and attachment.
 */
function canAuthor() {
    return state.context === 'codex';
}

let loreEntriesCache = [];
let loreBooksCache = [];

/** Warm the lore lists the editor needs, since rendering is synchronous. */
export async function refreshVariableLore() {
    try {
        loreEntriesCache = await listLoreEntries();
        loreBooksCache = await listLoreBooks();
    } catch {
        loreEntriesCache = [];
        loreBooksCache = [];
    }
}

/** The lorebook bound to the active Timeline, if any. Defaults the browser. */
function timelineLorebookName() {
    try {
        const store = getTimelineStore();
        return store.timelines[store.activeTimelineId]?.lorebookName || '';
    } catch {
        return '';
    }
}

function activeTimelineId() {
    try {
        return getTimelineStore().activeTimelineId || '';
    } catch {
        return '';
    }
}

function entryFor(ref) {
    const key = entryKey(ref);
    return loreEntriesCache.find((entry) => entryKey(entry) === key) || null;
}

// ---------------------------------------------------------------- State drawer

/** Body markup shared by the Story and Roleplay rails. One instance, relocated. */
export function buildVariableStateBodyMarkup() {
    return `<div class="remodel-varstate" data-remodel-varstate>${renderVariableStateInner()}</div>`;
}

export function renderVariableStateInner() {
    state.context = 'readonly';
    const timelineId = activeTimelineId();
    if (!timelineId) return '<p class="remodel-varstate-empty">Open a Scene in a Timeline to see its state.</p>';
    const tab = (id, label) => `<button type="button" data-remodel-varstate-pane="${id}" class="${state.pane === id ? 'is-active' : ''}">${label}</button>`;
    return `
        <nav class="remodel-varstate-tabs">
            ${tab('relevant', 'Relevant')}${tab('all', 'All')}${tab('history', 'History')}${tab('retrieval', 'Retrieval')}
        </nav>
        ${state.notice ? `<p class="remodel-varstate-notice">${escapeHtml(state.notice)}</p>` : ''}
        <div class="remodel-varstate-pane">${renderPane(timelineId)}</div>`;
}

function renderPane(timelineId) {
    if (state.pane === 'all') return renderAllPane(timelineId);
    if (state.pane === 'history') return renderHistoryPane(timelineId);
    if (state.pane === 'retrieval') return renderRetrievalPane(timelineId);
    return renderRelevantPane(timelineId);
}

/**
 * What the Director last actually saw — read from the retrieval layer's own
 * cache rather than the debug journal, so pausing diagnostics does not empty it.
 */
function renderRelevantPane(timelineId) {
    const last = getLastVariableContext(timelineId);
    const preview = `<button type="button" class="remodel-varstate-action" data-remodel-varstate-action="preview" ${state.busy === 'preview' ? 'disabled' : ''}>
        ${state.busy === 'preview' ? 'Retrieving…' : 'Preview retrieval now'}</button>`;
    if (!last) {
        // True of both empty cases, and there are two: no pass has ever run, or
        // the Variables changed and the snapshot was dropped as stale. Saying
        // "yet" alone would read as a bug the moment a Variable is edited.
        return `<p class="remodel-varstate-empty">No retrieval has run for this Timeline since its Variables last changed. A directed pass records one, or preview it here.</p>${preview}`;
    }
    const rows = last.listed.map(({ ref, variable, reasons }) => `
        <article class="remodel-varstate-row">
            <code>${escapeHtml(ref)}</code>
            <div><strong>${escapeHtml(variable.name)}</strong><small>${escapeHtml(reasons.join(' '))}</small></div>
            <output>${escapeHtml(formatVariable(variable))}</output>
        </article>`).join('');
    return `
        <p class="remodel-varstate-meta">${last.listed.length} of ${last.diagnostics.length} Variables, ${escapeHtml(relativeTime(last.at))}${last.degraded ? ' · deterministic fallback' : ''}</p>
        ${rows || '<p class="remodel-varstate-empty">That pass retrieved nothing.</p>'}
        ${preview}`;
}

function renderAllPane(timelineId) {
    const variables = listVariableValues({ timelineId });
    if (canAuthor() && state.creating) return renderEditor(null, state.creatingFor);
    if (canAuthor() && state.editingId) {
        const variable = getVariableValue(state.editingId, timelineId);
        if (variable) return renderEditor(variable, null);
    }
    const groups = new Map();
    for (const variable of variables) {
        const keys = variable.loreLinks.length ? variable.loreLinks.map(entryKey) : ['(unlinked)'];
        for (const key of keys) {
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(variable);
        }
    }
    const sections = [...groups.entries()].map(([key, items]) => {
        const entry = key === '(unlinked)' ? null : entryFor(refFromKey(key));
        const label = key === '(unlinked)' ? 'Not attached to any entry' : entry?.name || `Missing entry · ${key}`;
        return `
            <section class="remodel-varstate-group ${!entry && key !== '(unlinked)' ? 'is-unresolved' : ''}">
                <h4>${escapeHtml(label)}</h4>
                ${items.map(renderVariableCard).join('')}
            </section>`;
    }).join('');
    return `
        ${sections || '<p class="remodel-varstate-empty">This Timeline has no Variables yet.</p>'}
        ${canAuthor() ? '<button type="button" class="remodel-varstate-action" data-remodel-varstate-action="create">Add a Variable</button>' : ''}`;
}

function renderVariableCard(variable) {
    const computed = computeVariable(variable);
    const modifiers = variable.modifiers.length ? ` · ${variable.modifiers.length} modifier${variable.modifiers.length === 1 ? '' : 's'}` : '';
    return `
        <article class="remodel-varstate-card ${state.editingId === variable.id ? 'is-active' : ''}" data-remodel-varstate-variable="${escapeAttribute(variable.id)}">
            <div><strong>${escapeHtml(variable.name)}</strong><small>${escapeHtml(variable.valueType)}${escapeHtml(modifiers)}</small></div>
            <output>${escapeHtml(formatVariable(variable))}${computed?.modified ? ' *' : ''}</output>
            ${canAuthor() ? `<button type="button" data-remodel-varstate-action="edit" data-id="${escapeAttribute(variable.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button>` : ''}
        </article>`;
}

function renderHistoryPane(timelineId) {
    const events = listVariableEvents({ timelineId }).slice(-80).reverse();
    if (!events.length) return '<p class="remodel-varstate-empty">Nothing has changed yet.</p>';
    return events.map((event) => `
        <article class="remodel-varstate-event">
            <time>${escapeHtml(relativeTime(event.at))}</time>
            <div><strong>${escapeHtml(event.variableName || event.variableId || 'Variable')}</strong><small>${escapeHtml(event.type || 'changed')}${event.reason ? ` · ${escapeHtml(event.reason)}` : ''}</small></div>
            <output>${escapeHtml(String(event.after ?? ''))}</output>
        </article>`).join('');
}

/**
 * Why each Variable did or did not surface, plus the health of the index that
 * decides it. The exclusion reasons are the whole point — "it did not appear"
 * is the question this view exists to answer.
 */
function renderRetrievalPane(timelineId) {
    const vector = getVectorIndexState(timelineId);
    const last = getLastVariableContext(timelineId);
    const status = `
        <div class="remodel-varstate-vector ${vector.degraded ? 'is-degraded' : ''}">
            <span>${vector.degraded ? 'Semantic retrieval unavailable' : `Indexed · ${Object.keys(vector.hashes || {}).length} documents`}${vector.dirty ? ' · pending reindex' : ''}</span>
            ${vector.error ? `<small>${escapeHtml(vector.error)}</small>` : ''}
            <button type="button" class="remodel-varstate-action" data-remodel-varstate-action="reindex" ${state.busy === 'reindex' ? 'disabled' : ''}>
                ${state.busy === 'reindex' ? 'Reindexing…' : 'Reindex now'}</button>
        </div>`;
    if (!last) return `${status}<p class="remodel-varstate-empty">No retrieval has run for this Timeline since its Variables last changed.</p>`;
    // Goals rank against Variables under one shared budget, so this view has to
    // show both kinds or it explains half a decision. The kind badge is what
    // separates a Goal that scored badly from one that was never eligible —
    // Goals have no retrieval.mode, so only the budget can keep them out.
    const rows = last.diagnostics.map((item) => `
        <article class="remodel-varstate-diag ${item.included ? 'is-in' : 'is-out'}">
            <div><strong>${escapeHtml(item.name)}</strong>
                <em class="remodel-varstate-kind">${item.kind === 'goal' ? 'Goal' : 'Variable'}</em>
                <small>${escapeHtml((item.channels || []).join(', ') || 'no evidence')}</small></div>
            <p>${escapeHtml(item.included ? item.why : item.excluded)}</p>
        </article>`).join('');
    return `${status}<p class="remodel-varstate-meta">${escapeHtml(relativeTime(last.at))}${last.degraded ? ` · ${escapeHtml(last.vectorError)}` : ''}</p>${rows}`;
}

// --------------------------------------------------------------- Lorebook seam

/**
 * What this Lorebook entry drives. Read-only by design.
 *
 * A Variable is authored in the Codex, where it can be attached to many entries
 * at once; this answers the question you have while reading an entry — what
 * current state does this prose govern — and nothing more.
 */
export function renderLinkedVariablesSection(ref) {
    state.context = 'readonly';
    const timelineId = activeTimelineId();
    if (!timelineId) return '<p class="remodel-varlink-empty">Open a Timeline to see the Variables attached to this entry.</p>';
    const attached = listVariablesForLoreRef(ref, { timelineId });
    if (!attached.length) return '<p class="remodel-varlink-empty">No Variables are attached to this entry. Attach one from the Timeline’s Variables Codex.</p>';
    return attached.map((variable) => `
        <article class="remodel-varstate-card">
            <div><strong>${escapeHtml(variable.name)}</strong><small>${escapeHtml(variable.description || variable.valueType)}</small></div>
            <output>${escapeHtml(formatVariable(variable))}</output>
        </article>`).join('');
}

// ---------------------------------------------------------------------- Codex

/**
 * The Variables Codex: the Timeline's own view of its state, and the one place
 * a Variable is created, edited, and attached to the entries it describes.
 */
export function renderVariableCodex() {
    state.context = 'codex';
    const timelineId = activeTimelineId();
    if (!timelineId) return '<p class="remodel-varstate-empty">Open a Timeline to author its Variables.</p>';
    const variables = listVariableValues({ timelineId });
    const selected = state.creating
        ? null
        : getVariableValue(state.editingId, timelineId) || variables[0] || null;
    const detail = state.creating
        ? renderEditor(null, state.creatingFor)
        : selected ? renderEditor(selected, null) : '<p class="remodel-varstate-empty">This Timeline has no Variables yet. Add one to begin.</p>';
    return `
        <div class="remodel-codex" data-remodel-varcodex>
            <aside class="remodel-codex-list">
                <header>
                    <span>${variables.length} Variable${variables.length === 1 ? '' : 's'}</span>
                    <button type="button" class="remodel-varstate-action" data-remodel-varstate-action="create">Add</button>
                </header>
                ${variables.map(renderVariableCard).join('') || '<p class="remodel-varstate-empty">Nothing yet.</p>'}
            </aside>
            <section class="remodel-codex-detail">
                ${state.notice ? `<p class="remodel-varstate-notice">${escapeHtml(state.notice)}</p>` : ''}
                ${detail}
            </section>
        </div>`;
}

// -------------------------------------------------------------------- Editor

/**
 * One editor for both mount points.
 *
 * Rendered as a div, not a form. One of those mount points is inside native's
 * `form.world_entry_form`, and the HTML parser silently drops a nested <form>
 * tag — leaving the fields behind but detaching them from any selector that
 * expects the wrapper. Nothing here needs form semantics; values are read on
 * save.
 *
 * @param {object|null} variable existing record, or null when creating
 * @param {object|null} presetRef lore entry a new Variable starts attached to
 */
function renderEditor(variable, presetRef) {
    const draft = variable || {
        id: '', name: '', description: '', valueType: 'number', value: 0, enumValues: [], subvalues: [],
        loreLinks: presetRef ? [{ ...presetRef, hint: presetRef.hint || 'subject' }] : [],
        retrieval: { mode: presetRef ? 'corroborated' : 'always', semanticThreshold: 0.7, continuity: true },
        authority: 'world', modifiers: [],
    };
    const id = escapeAttribute(draft.id);
    const option = (value, label, selected) => `<option value="${escapeAttribute(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const min = draft.subvalues.find((item) => item.role === 'minimum');
    const max = draft.subvalues.find((item) => item.role === 'maximum');
    return `
        <div class="remodel-varedit" data-remodel-varstate-form data-id="${id}">
            <label class="is-wide">Name<input type="text" name="name" value="${escapeAttribute(draft.name)}" placeholder="Aiden's HP" required></label>
            <label class="is-wide">Meaning<textarea name="description" rows="2" placeholder="What this value means in the fiction.">${escapeHtml(draft.description)}</textarea></label>
            <label>Type<select name="valueType">${VARIABLE_TYPES.map((type) => option(type, type, draft.valueType)).join('')}</select></label>
            <label>Value<input type="text" name="value" value="${escapeAttribute(String(draft.value ?? ''))}"></label>
            ${draft.valueType === 'number' ? `
                <label>Minimum<input type="number" name="minimum" value="${escapeAttribute(min ? String(min.value) : '')}" placeholder="none"></label>
                <label>Maximum<input type="number" name="maximum" value="${escapeAttribute(max ? String(max.value) : '')}" placeholder="none"></label>` : ''}
            ${draft.valueType === 'enum' ? `
                <label class="is-wide">States<input type="text" name="enumValues" value="${escapeAttribute(draft.enumValues.join(', '))}" placeholder="calm, wary, hostile"></label>` : ''}
            <label>Who may change it
                <select name="authority">
                    ${option('world', 'World or NPC — apply automatically', draft.authority)}
                    ${option('review', 'Needs my review', draft.authority)}
                    ${option('user', 'Mine — needs authorization', draft.authority)}
                    ${option('persona', 'My persona — needs authorization', draft.authority)}
                </select></label>
            <label>Retrieval<select name="mode">${RETRIEVAL_MODES.map((mode) => option(mode, mode, draft.retrieval.mode)).join('')}</select></label>
            <label>Semantic threshold<input type="number" name="semanticThreshold" min="0" max="1" step="0.01" value="${escapeAttribute(String(draft.retrieval.semanticThreshold))}"></label>
            <fieldset class="is-wide">
                <legend>Attached entries</legend>
                <div class="remodel-varedit-chips">
                    ${draft.loreLinks.map((link) => renderLinkChip(link, draft.id)).join('') || '<em>Not attached to any entry.</em>'}
                </div>
                ${draft.id
        ? renderEntryBrowser(draft, timelineLorebookName())
        : '<p class="remodel-varedit-note">Create it first, then attach as many entries as it governs.</p>'}
                <p class="remodel-varedit-note">A Variable needs at least one attached entry unless its retrieval mode is <code>always</code>.</p>
            </fieldset>
            ${draft.id && draft.modifiers.length ? `
                <fieldset class="is-wide"><legend>Modifiers</legend><div class="remodel-varedit-chips">
                    ${draft.modifiers.map((mod) => `<span class="remodel-varedit-chip">${escapeHtml(mod.label || 'modifier')} ${Number(mod.amount) >= 0 ? '+' : ''}${escapeHtml(String(mod.amount))} ${escapeHtml(mod.target)}
                        <button type="button" data-remodel-varstate-action="modifier-remove" data-id="${id}" data-modifier="${escapeAttribute(mod.id)}" title="Remove">×</button></span>`).join('')}
                </div></fieldset>` : ''}
            <footer class="is-wide">
                <button type="button" data-remodel-varstate-action="save" data-id="${id}">${draft.id ? 'Save' : 'Create'}</button>
                <button type="button" data-remodel-varstate-action="cancel">Cancel</button>
                ${draft.id ? `<button type="button" class="is-danger" data-remodel-varstate-action="delete" data-id="${id}">Delete</button>` : ''}
            </footer>
        </div>`;
}

function renderLinkChip(link, variableId) {
    const entry = entryFor(link);
    const unresolved = !entry;
    return `
        <span class="remodel-varedit-chip ${unresolved ? 'is-unresolved' : ''}" title="${escapeAttribute(unresolved ? 'This entry no longer exists — rebind or detach it.' : entry.name)}">
            ${unresolved ? '<i class="fa-solid fa-link-slash"></i>' : ''}${escapeHtml(entry?.name || `${link.book} #${link.uid}`)}
            <em>${escapeHtml(link.hint)}</em>
            ${variableId ? `<button type="button" data-remodel-varstate-action="detach" data-id="${escapeAttribute(variableId)}" data-book="${escapeAttribute(link.book)}" data-uid="${escapeAttribute(link.uid)}" title="Detach">×</button>` : ''}
        </span>`;
}

/**
 * Attach one Variable to many entries in a single pass.
 *
 * The relationship runs one-to-many, so this is driven from the Variable's
 * side: pick a book, filter, and tick every entry the value governs. Ticking
 * writes immediately — there is no separate save for attachments, so a long
 * session of ticking cannot be lost by navigating away.
 *
 * Defaults to the book bound to this Timeline, because that is where a
 * Timeline's own lore lives, while leaving every other book reachable.
 */
function renderEntryBrowser(variable, boundBook) {
    const books = loreBooksCache;
    // Prefer the Timeline's own book; failing that, the book this Variable is
    // already attached to — opening on a book with none of its attachments
    // shows "2 attached" beside zero ticks, which reads as a bug.
    const attachedBook = variable?.loreLinks?.[0]?.book || '';
    const active = state.pickerBook || boundBook || attachedBook || books[0]?.book || '';
    const entries = books.find((book) => book.book === active)?.entries || [];
    const needle = state.pickerSearch.trim().toLowerCase();
    const matches = needle
        ? entries.filter((entry) => `${entry.name} ${(entry.keys || []).join(' ')}`.toLowerCase().includes(needle))
        : entries;
    const attached = new Set((variable?.loreLinks || []).map(entryKey));
    return `
        <div class="remodel-varedit-picker">
            <div class="remodel-varedit-picker-head">
                <select data-remodel-varstate-picker-book>
                    ${books.map((book) => `<option value="${escapeAttribute(book.book)}" ${book.book === active ? 'selected' : ''}>${escapeHtml(book.book)}${book.book === boundBook ? ' · this Timeline' : ''}</option>`).join('')}
                </select>
                <input type="search" data-remodel-varstate-picker-search value="${escapeAttribute(state.pickerSearch)}" placeholder="Filter entries…">
            </div>
            <div class="remodel-varedit-picker-list">
                ${matches.slice(0, 300).map((entry) => {
        const key = entryKey(entry);
        const on = attached.has(key);
        return `
                    <label class="remodel-varedit-picker-entry ${entry.disabled ? 'is-disabled' : ''} ${on ? 'is-on' : ''}">
                        <input type="checkbox" data-remodel-varstate-attach data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}" ${on ? 'checked' : ''}>
                        <span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml((entry.keys || []).slice(0, 5).join(', '))}</small></span>
                    </label>`;
    }).join('') || `<em>${needle ? 'No entry matches that filter.' : 'This book has no entries.'}</em>`}
            </div>
            <p class="remodel-varedit-note" data-attached="${attached.size}">${attached.size} attached${matches.length !== entries.length ? ` · showing ${matches.length} of ${entries.length}` : ''}. Changes save as you tick.</p>
        </div>`;
}

// ------------------------------------------------------------------- Handlers

export function handleVariablesUiClick(target, requestRender) {
    const action = target.closest('[data-remodel-varstate-action]')?.dataset;
    const paneButton = target.closest('[data-remodel-varstate-pane]');
    if (paneButton) {
        state.pane = paneButton.dataset.remodelVarstatePane || 'relevant';
        state.editingId = '';
        state.creatingFor = null;
        requestRender();
        return true;
    }
    const card = target.closest('[data-remodel-varstate-variable]');
    if (card && canAuthor() && !action) {
        state.editingId = card.dataset.remodelVarstateVariable || '';
        state.creating = false;
        state.creatingFor = null;
        requestRender();
        return true;
    }
    if (!action) return false;
    const name = action.remodelVarstateAction;
    const form = target.closest('[data-remodel-varstate-form]');

    if (name === 'create') {
        // From a Lorebook entry the new Variable starts attached to it; from the
        // drawer it starts unattached, which is why `always` is its default mode.
        state.creating = true;
        state.creatingFor = action.book ? { book: action.book, uid: action.uid, hint: 'subject' } : null;
        state.editingId = '';
        requestRender();
        return true;
    }
    if (name === 'edit') { state.editingId = action.id || ''; state.creating = false; state.creatingFor = null; requestRender(); return true; }
    if (name === 'cancel') { state.editingId = ''; state.creating = false; state.creatingFor = null; state.pickerSearch = ''; requestRender(); return true; }
    if (name === 'save') { saveFromForm(form, action.id, requestRender); return true; }
    if (name === 'delete') {
        if (confirm('Delete this Variable and its history?')) {
            deleteVariableValue(action.id, { actor: 'user' });
            state.editingId = '';
        }
        requestRender();
        return true;
    }
    if (name === 'detach') {
        try {
            detachEntry(action.id, { book: action.book, uid: action.uid }, { actor: 'user' });
        } catch (error) {
            state.notice = String(error?.message || error);
        }
        requestRender();
        return true;
    }
    if (name === 'modifier-remove') { removeVariableModifier(action.id, action.modifier, { actor: 'user' }); requestRender(); return true; }
    if (name === 'preview') { runPreview(requestRender); return true; }
    if (name === 'reindex') { runReindex(requestRender); return true; }
    return false;
}

/**
 * Live entry filter.
 *
 * Hides rows in place rather than re-rendering: a re-render on every keystroke
 * would rebuild the input and take the caret with it. `state.pickerSearch` is
 * kept in step so the filter survives the re-render that ticking a box causes.
 */
export function handleVariablesUiInput(target) {
    if (!target.matches('[data-remodel-varstate-picker-search]')) return false;
    state.pickerSearch = target.value || '';
    const needle = state.pickerSearch.trim().toLowerCase();
    const list = target.closest('.remodel-varedit-picker')?.querySelector('.remodel-varedit-picker-list');
    let shown = 0;
    for (const row of list?.querySelectorAll('.remodel-varedit-picker-entry') || []) {
        const match = !needle || row.textContent.toLowerCase().includes(needle);
        row.hidden = !match;
        if (match) shown++;
    }
    const note = target.closest('.remodel-varedit-picker')?.querySelector('.remodel-varedit-note');
    if (note) note.textContent = `${note.dataset.attached || '0'} attached${needle ? ` · showing ${shown}` : ''}. Changes save as you tick.`;
    return true;
}

export function handleVariablesUiChange(target, requestRender) {
    if (target.matches('[data-remodel-varstate-picker-book]')) {
        state.pickerBook = target.value || '';
        state.pickerSearch = '';
        requestRender();
        return true;
    }
    // Ticking writes straight through. Attachment is not part of the editor's
    // save, so a long session of ticking cannot be lost by navigating away, and
    // the checkbox reflects stored truth on the next render.
    if (target.matches('[data-remodel-varstate-attach]')) {
        const editor = target.closest('[data-remodel-varstate-form]');
        const id = editor?.dataset.id || state.editingId;
        const ref = { book: target.dataset.book, uid: target.dataset.uid, hint: 'subject' };
        try {
            if (target.checked) attachEntry(id, ref, { actor: 'user' });
            else detachEntry(id, ref, { actor: 'user' });
            state.notice = '';
        } catch (error) {
            state.notice = String(error?.message || error);
        }
        requestRender();
        return true;
    }
    // The type selector changes which fields exist, so it re-renders; everything
    // else is read on save, so typing is never interrupted mid-field.
    if (target.matches('[data-remodel-varstate-form] select[name="valueType"]')) {
        const form = target.closest('[data-remodel-varstate-form]');
        const id = form?.dataset.id || '';
        if (id) updateVariableValue(id, { valueType: target.value }, { actor: 'user' });
        else if (state.creatingFor) state.creatingFor = { ...state.creatingFor, valueType: target.value };
        requestRender();
        return true;
    }
    return false;
}

function saveFromForm(form, id, requestRender) {
    if (!form) return;
    const read = (field) => form.querySelector(`[name="${field}"]`)?.value ?? '';
    const subvalues = [];
    if (read('valueType') === 'number') {
        if (read('minimum') !== '') subvalues.push({ key: 'minimum', label: 'Minimum', type: 'number', value: Number(read('minimum')), role: 'minimum' });
        if (read('maximum') !== '') subvalues.push({ key: 'maximum', label: 'Maximum', type: 'number', value: Number(read('maximum')), role: 'maximum' });
    }
    const patch = {
        name: read('name').trim(),
        description: read('description').trim(),
        valueType: read('valueType'),
        value: read('value'),
        enumValues: read('enumValues').split(',').map((item) => item.trim()).filter(Boolean),
        subvalues,
        authority: read('authority'),
        retrieval: { mode: read('mode'), semanticThreshold: Number(read('semanticThreshold')), continuity: true },
    };
    if (!patch.name) { state.notice = 'A Variable needs a name.'; requestRender(); return; }
    try {
        if (id) {
            updateVariableValue(id, patch, { actor: 'user' });
            state.editingId = id;
        } else {
            const links = state.creatingFor?.book ? [{ ...state.creatingFor, hint: state.creatingFor.hint || 'subject' }] : [];
            const made = createVariableValue({ ...patch, timelineId: activeTimelineId(), loreLinks: links }, { actor: 'user' });
            if (!made) {
                state.notice = patch.retrieval.mode === 'always'
                    ? 'That Variable could not be created. Check it has a name.'
                    : `A Variable set to “${patch.retrieval.mode}” retrieval needs at least one attached entry. Use “always” for a Timeline-wide fact.`;
                requestRender();
                return;
            }
            // Stay on the new Variable so its entry browser is right there.
            state.editingId = made.id;
        }
        state.notice = '';
        state.creating = false;
        state.creatingFor = null;
    } catch (error) {
        state.notice = String(error?.message || error);
    }
    requestRender();
}

async function runPreview(requestRender) {
    state.busy = 'preview';
    state.notice = '';
    requestRender();
    try {
        const { resolveVariableContext } = await import('./variables-context.js');
        await resolveVariableContext({
            timelineId: activeTimelineId(),
            action: '[preview only: retrieve state; do not mutate or roll]',
            history: [], cast: [], activatedEntries: [], goals: [],
        });
    } catch (error) {
        state.notice = String(error?.message || error);
    }
    state.busy = '';
    requestRender();
}

async function runReindex(requestRender) {
    state.busy = 'reindex';
    requestRender();
    try {
        const result = await ensureVariableVectorIndex(activeTimelineId(), { force: true });
        state.notice = result.ok ? 'Reindexed.' : `Reindex failed: ${result.state?.error || 'unknown error'}`;
    } catch (error) {
        state.notice = String(error?.message || error);
    }
    state.busy = '';
    requestRender();
}

// -------------------------------------------------------------------- Helpers

function refFromKey(key) {
    const index = String(key).lastIndexOf('.');
    return index < 0 ? { book: key, uid: '' } : { book: String(key).slice(0, index), uid: String(key).slice(index + 1) };
}

function relativeTime(at) {
    const then = Date.parse(at || '');
    if (!Number.isFinite(then)) return 'just now';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return new Date(then).toLocaleDateString();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttribute(value) { return escapeHtml(value); }
