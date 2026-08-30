import { listLivingLoreMetadata, upsertLivingLoreMetadata } from './living-lore-store.js';
import { getTimelineStore } from './timeline-state.js';
import { getWorldSenseTurnOverrides, setWorldSenseTurnOverride } from './world-sense-runtime.js';
import { loadTimelineLore } from './world-sense-lore.js';
import {
    getWorldSenseIndexState,
    getWorldSenseProfile,
    listWorldSenseReceipts,
    updateWorldSenseProfile,
} from './world-sense-store.js';
import {
    buildWorldSenseDryRun,
    buildWorldSenseRefusals,
    describeWorldSenseReasons,
    filterWorldSenseWorkspaceEntries,
} from './world-sense-workspace-model.js';

const states = new WeakMap();

export function renderWorldSenseWorkspaceShell() {
    return '<section class="remodel-world-sense" data-remodel-world-sense aria-label="World Sense" aria-busy="true"><div class="remodel-world-sense-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Timeline lore…</div></section>';
}

export async function mountWorldSenseWorkspace(root) {
    if (!(root instanceof HTMLElement)) return;
    let state = states.get(root);
    if (!state) {
        state = { query: '', status: 'all', selectedKey: '', semanticMatches: [], busy: '', message: '', cultivationDraft: null, conflictKey: '', bound: false };
        states.set(root, state);
    }
    if (!state.bound) bind(root, state);
    await refresh(root, state);
}

async function refresh(root, state) {
    const timelineStore = getTimelineStore();
    const timelineId = String(timelineStore.activeTimelineId || '');
    const timeline = timelineStore.timelines[timelineId] || null;
    const lore = await loadTimelineLore(timelineId);
    const metadata = listLivingLoreMetadata({ timelineId, book: lore.book || '' });
    const receipts = listWorldSenseReceipts().filter((item) => item.timelineId === timelineId);
    const receipt = receipts.at(-1) || null;
    const entries = filterWorldSenseWorkspaceEntries({
        entries: lore.entries,
        metadata,
        receipt,
        semanticMatches: state.semanticMatches,
        query: state.query,
        status: state.status,
    });
    if (!entries.some((entry) => entry.key === state.selectedKey)) state.selectedKey = entries[0]?.key || '';
    const selected = entries.find((entry) => entry.key === state.selectedKey) || null;
    const sceneId = String(timeline?.activeSceneId || '');
    const turnOverrides = getWorldSenseTurnOverrides(sceneId);
    const profile = getWorldSenseProfile();
    const index = getWorldSenseIndexState(timelineId);
    const dryRun = buildWorldSenseDryRun({ entries: lore.entries, metadata, receipt });
    const refusals = buildWorldSenseRefusals({ entries: lore.entries, receipt });
    root.innerHTML = render({ timeline, lore, entries, selected, profile, index, receipt, dryRun, refusals, turnOverrides, sceneId, state });
    root.setAttribute('aria-busy', String(Boolean(state.busy)));
}

function render(view) {
    const { timeline, lore, entries, selected, profile, index, receipt, dryRun, refusals, turnOverrides, sceneId, state } = view;
    if (!timeline) return '<div class="remodel-world-sense-empty"><h3>No active Timeline</h3><p>Select a Timeline before configuring World Sense.</p></div>';
    const indexed = Object.keys(index?.hashes || {}).length;
    return `
        <header class="remodel-world-sense-head">
            <div><span class="remodel-world-sense-kicker">Timeline intelligence</span><h2>World Sense</h2><p>${escapeHtml(timeline.title || 'Untitled Timeline')} · ${escapeHtml(lore.book || 'No Living Lore book assigned')}</p></div>
        </header>
        ${state.message ? `<div class="remodel-world-sense-notice" role="status">${escapeHtml(state.message)}</div>` : ''}
        <section class="remodel-world-sense-status" aria-label="World Sense status">
            <div><span>Local model</span><strong>${escapeHtml(profile.modelId)}</strong><small>Hugging Face embeddings</small></div>
            <div><span>Index</span><strong class="is-${escapeAttribute(index?.status || 'idle')}">${escapeHtml(index?.status || 'idle')}</strong><small>${indexed} document${indexed === 1 ? '' : 's'} · ${lore.entries.length} lore · ${escapeHtml(relativeTime(index?.indexedAt))}</small></div>
            <div><span>Last retrieval</span><strong>${receipt ? `${receipt.selected?.length || 0} selected` : 'No receipt'}</strong><small>${receipt ? `${receipt.elapsedMs || 0} ms · ${receipt.degraded ? 'mentions only' : 'mentions + vector'}` : 'Run a scene or search below'}</small></div>
        </section>
        <details class="remodel-world-sense-settings">
            <summary>Model and retrieval limits</summary>
            <div>
                <label>Model<input type="text" value="${escapeAttribute(profile.modelId)}" data-ws-profile="modelId"></label>
                <label>Entry budget<input type="number" min="1" max="50" value="${profile.maxEntries}" data-ws-profile="maxEntries"></label>
                <label>Token budget<input type="number" min="100" max="12000" value="${profile.maxTokens}" data-ws-profile="maxTokens"></label>
                <label>Similarity gate<input type="number" min="0" max="1" step="0.05" value="${profile.semanticThreshold}" data-ws-profile="semanticThreshold"></label>
            </div>
        </details>
        <div class="remodel-world-sense-grid">
            <section class="remodel-world-sense-browser" aria-label="Living Lore browser">
                <form data-ws-search-form class="remodel-world-sense-search">
                    <label><span class="sr-only">Search Living Lore</span><i class="fa-solid fa-magnifying-glass"></i><input value="${escapeAttribute(state.query)}" data-ws-search placeholder="Filter by name, key or text"></label>
                    <button type="submit">Filter</button>
                </form>
                <div class="remodel-world-sense-filters">
                    <label>Status<select data-ws-filter="status">${['all', 'selected', 'pinned', 'excluded'].map((status) => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${title(status)}</option>`).join('')}</select></label>
                    <span>${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
                </div>
                <div class="remodel-world-sense-entry-list" role="listbox" aria-label="Living Lore entries">
                    ${entries.length ? entries.map((entry) => renderEntry(entry, state.selectedKey)).join('') : '<div class="remodel-world-sense-empty compact">No entries match these filters.</div>'}
                </div>
            </section>
            <section class="remodel-world-sense-inspector" aria-label="Living Lore inspector">
                ${selected ? renderInspector(selected, { turnOverrides, sceneId }) : '<div class="remodel-world-sense-empty"><h3>Select an entry</h3><p>Inspect retrieval evidence, protection and links here.</p></div>'}
            </section>
        </div>
        <details class="remodel-world-sense-dryrun">
            <summary><span>Prompt dry run</span><strong>${dryRun.entries.length} entr${dryRun.entries.length === 1 ? 'y' : 'ies'} · ${dryRun.budget?.usedTokens || 0}/${dryRun.budget?.maxTokens || profile.maxTokens} tokens</strong></summary>
            <p>This is the bounded Living Lore packet selected for the latest Preview/Narrator/Loom pass.</p>
            ${dryRun.entries.map((entry) => `<article><header><strong>${escapeHtml(entry.name)}</strong><span>rev ${entry.revision}</span></header><small>${escapeHtml(entry.reasons.join(' · ') || 'forced selection')}</small><pre>${escapeHtml(entry.content)}</pre></article>`).join('') || '<p class="remodel-world-sense-muted">No retrieval receipt exists for this Timeline yet.</p>'}
        </details>
        <details class="remodel-world-sense-refusals">
            <summary><span>Considered and refused</span><strong>${refusals.length} entr${refusals.length === 1 ? 'y' : 'ies'}</strong></summary>
            <p>What the last retrieval reached and turned away, nearest miss first. An entry only appears here if something connected it to the scene.</p>
            ${refusals.length ? `<ul>${refusals.map(renderRefusal).join('')}</ul>` : '<p class="remodel-world-sense-muted">Nothing was refused. Either everything connected to the scene earned its place, or no retrieval has run yet.</p>'}
        </details>
    `;
}

/** One refused entry: what it was, why it lost, and what vouched for it. The
 * near-miss numbers are the point — "scored too low" is only actionable when
 * you can see it missed by two hundredths rather than by a mile. */
function renderRefusal(row) {
    const facts = [];
    if (row.via) facts.push(`via ${escapeHtml(row.via)}${row.viaKey ? ` (“${escapeHtml(row.viaKey)}”)` : ''}`);
    if (Number.isFinite(row.depth) && row.depth > 0) facts.push(`depth ${row.depth}`);
    if (Number.isFinite(row.similarity)) {
        const scored = `scored ${Math.round(row.similarity * 100)}%`;
        facts.push(Number.isFinite(row.bar) ? `${scored} against ${Math.round(row.bar * 100)}%` : scored);
    }
    return `<li>
        <div><strong>${escapeHtml(row.name)}</strong><em>${escapeHtml(row.label)}</em></div>
        ${facts.length ? `<small>${facts.join(' · ')}</small>` : ''}
    </li>`;
}

function renderEntry(entry, selectedKey) {
    const reasons = describeWorldSenseReasons(entry.reasons);
    return `<button type="button" role="option" aria-selected="${entry.key === selectedKey}" class="remodel-world-sense-entry ${entry.key === selectedKey ? 'is-selected' : ''}" data-ws-entry="${escapeAttribute(entry.key)}">
        <span class="remodel-world-sense-entry-top"><strong>${escapeHtml(entry.name)}</strong></span>
        <span class="remodel-world-sense-entry-keys">${escapeHtml([...entry.keys, ...entry.secondaryKeys].slice(0, 5).join(' · ') || 'No keys')}</span>
        <span class="remodel-world-sense-entry-reason">${entry.selected ? `<b>${entry.score} pts</b> ${escapeHtml(reasons.join(' · '))}` : entry.semanticScore != null ? `<b>${Math.round(entry.semanticScore * 100)}%</b> semantic match` : escapeHtml(entry.decision || 'Not selected last turn')}</span>
        <span class="remodel-world-sense-entry-flags">${entry.pinned ? '<i class="fa-solid fa-thumbtack" title="Pinned"></i>' : ''}${entry.excluded ? '<i class="fa-solid fa-eye-slash" title="Excluded"></i>' : ''}${entry.protectedFields.length ? `<i class="fa-solid fa-lock" title="${entry.protectedFields.length} protected fields"></i>` : ''}<span>rev ${entry.revision}</span></span>
    </button>`;
}

function renderInspector(entry, { turnOverrides, sceneId }) {
    const reasons = describeWorldSenseReasons(entry.reasons);
    const nextPinned = turnOverrides.pins.some((item) => `${item.book}.${item.uid}` === entry.key);
    const nextExcluded = turnOverrides.excludes.some((item) => `${item.book}.${item.uid}` === entry.key);
    return `<form data-ws-metadata-form data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}">
        <header><div><span>${escapeHtml(entry.book)} · ${escapeHtml(entry.uid)}</span><h3>${escapeHtml(entry.name)}</h3></div><span class="remodel-world-sense-revision">rev ${entry.revision}</span></header>
        <p class="remodel-world-sense-evidence">${reasons.length ? `<b>Why it matched:</b> ${escapeHtml(reasons.join(' · '))}` : 'This entry was not part of the latest retrieval.'}</p>
        <div class="remodel-world-sense-meta-row"><label>Origin<input value="${escapeAttribute(entry.origin)}" disabled></label></div>
        <fieldset><legend>Next turn</legend><button type="button" data-ws-turn="${nextPinned ? 'clear' : 'pin'}" data-scene="${escapeAttribute(sceneId)}" data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}" class="${nextPinned ? 'is-active' : ''}" ${sceneId ? '' : 'disabled'}><i class="fa-solid fa-thumbtack"></i> ${nextPinned ? 'Pinned for next turn' : 'Pin for next turn'}</button><button type="button" data-ws-turn="${nextExcluded ? 'clear' : 'exclude'}" data-scene="${escapeAttribute(sceneId)}" data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}" class="${nextExcluded ? 'is-active' : ''}" ${sceneId ? '' : 'disabled'}><i class="fa-solid fa-eye-slash"></i> ${nextExcluded ? 'Excluded next turn' : 'Exclude next turn'}</button></fieldset>
        <fieldset><legend>Persistent handling</legend><label><input type="checkbox" name="pinned" ${entry.pinned ? 'checked' : ''}> Always pin</label><label><input type="checkbox" name="excluded" ${entry.excluded ? 'checked' : ''}> Always exclude</label></fieldset>
        <div class="remodel-world-sense-links"><span>Related entries</span>${entry.links.length ? entry.links.map((link) => `<span>${escapeHtml(link.relation)} → ${escapeHtml(link.target.book)} · ${escapeHtml(link.target.uid)}</span>`).join('') : '<em>No typed links yet</em>'}</div>
        <button type="submit">Save</button>
    </form>`;
}

function bind(root, state) {
    state.bound = true;
    root.addEventListener('click', async (event) => {
        const entry = event.target.closest?.('[data-ws-entry]');
        if (entry) { state.selectedKey = entry.dataset.wsEntry; await refresh(root, state); return; }
        const turn = event.target.closest?.('[data-ws-turn]');
        if (turn) {
            setWorldSenseTurnOverride(turn.dataset.scene, { book: turn.dataset.book, uid: turn.dataset.uid }, turn.dataset.wsTurn);
            state.message = turn.dataset.wsTurn === 'clear' ? 'Next-turn override cleared.' : `Entry will be ${turn.dataset.wsTurn === 'pin' ? 'pinned' : 'excluded'} for the next directed turn.`;
            await refresh(root, state);
        }
    });
    root.addEventListener('change', async (event) => {
        const profileField = event.target.dataset?.wsProfile;
        if (profileField) {
            updateWorldSenseProfile({ [profileField]: event.target.type === 'number' ? Number(event.target.value) : event.target.value });
            state.message = profileField === 'modelId' ? 'Model changed. Reindex before semantic search.' : 'World Sense settings saved.';
            await refresh(root, state);
            return;
        }
        const filter = event.target.dataset?.wsFilter;
        if (filter) { state[filter] = event.target.value; await refresh(root, state); }
    });
    root.addEventListener('submit', async (event) => {
        if (event.target.matches('[data-ws-search-form]')) {
            event.preventDefault();
            state.query = event.target.querySelector('[data-ws-search]')?.value.trim() || '';
            await refresh(root, state);
            return;
        }
        if (event.target.matches('[data-ws-metadata-form]')) {
            event.preventDefault();
            const form = event.target;
            upsertLivingLoreMetadata(getTimelineStore().activeTimelineId, { book: form.dataset.book, uid: form.dataset.uid }, {
                worldSense: { pinned: form.elements.pinned.checked, excluded: form.elements.excluded.checked },
            });
            state.message = 'Entry handling saved.';
            await refresh(root, state);
            return;
        }
    });
}

function relativeTime(value) {
    if (!value) return 'not indexed';
    const delta = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(delta)) return String(value);
    if (delta < 60000) return 'just now';
    if (delta < 3600000) return `${Math.round(delta / 60000)}m ago`;
    if (delta < 86400000) return `${Math.round(delta / 3600000)}h ago`;
    return `${Math.round(delta / 86400000)}d ago`;
}
function title(value) { const text = String(value || ''); return text.charAt(0).toUpperCase() + text.slice(1).replaceAll('-', ' '); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]); }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
