import { ensureWorldSenseIndex, queryWorldSense } from './world-sense-embeddings.js';
import { LIVING_LORE_ENTRY_TYPES, LIVING_LORE_PROTECTED_FIELDS } from './living-lore-model.js';
import {
    applyAutoSafeLivingLoreProposals,
    applyLivingLoreProposals,
    editLivingLoreProposalValue,
    listLivingLoreHistory,
    listLivingLoreProposals,
    queueLivingLoreProposals,
    rejectLivingLoreProposal,
    rollbackLivingLoreTransaction,
} from './living-lore-mutations.js';
import {
    buildCultivationPacket,
    cultivationSearchText,
    draftCultivationProposal,
    inspectCultivationConflicts,
    seedProtectionSummary,
} from './living-lore-cultivation.js';
import { AUTO_SAFE_OPERATIONS } from './living-lore-auto-safe.js';
import { listLivingLoreMetadata, upsertLivingLoreMetadata } from './living-lore-store.js';
import { getTimelineStore } from './timeline-state.js';
import { getWorldSenseTurnOverrides, setWorldSenseTurnOverride } from './world-sense-runtime.js';
import { loadTimelineLore } from './world-sense-lore.js';
import {
    getWorldSenseIndexState,
    getWorldSenseProfile,
    listWorldSenseProposalRejections,
    listWorldSenseReceipts,
    updateWorldSenseProfile,
    WORLD_SENSE_MODES,
} from './world-sense-store.js';
import {
    buildWorldSenseDryRun,
    describeWorldSenseReasons,
    filterWorldSenseWorkspaceEntries,
    proposalDiffRows,
} from './world-sense-workspace-model.js';

const states = new WeakMap();
const SAFE_OPERATIONS = new Set(AUTO_SAFE_OPERATIONS);

export function renderWorldSenseWorkspaceShell() {
    return '<section class="remodel-world-sense" data-remodel-world-sense aria-label="World Sense" aria-busy="true"><div class="remodel-world-sense-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading Timeline lore…</div></section>';
}

export async function mountWorldSenseWorkspace(root) {
    if (!(root instanceof HTMLElement)) return;
    let state = states.get(root);
    if (!state) {
        state = { query: '', type: 'all', status: 'all', selectedKey: '', semanticMatches: [], busy: '', message: '', cultivationDraft: null, conflictKey: '', bound: false };
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
    const proposalRejections = listWorldSenseProposalRejections({ timelineId }).slice().reverse().slice(0, 12);
    const proposals = listLivingLoreProposals({ timelineId }).filter((item) => item.status === 'suggested').reverse();
    const history = listLivingLoreHistory({ timelineId }).slice().reverse();
    const entries = filterWorldSenseWorkspaceEntries({
        entries: lore.entries,
        metadata,
        receipt,
        semanticMatches: state.semanticMatches,
        query: state.query,
        type: state.type,
        status: state.status,
    });
    if (!entries.some((entry) => entry.key === state.selectedKey)) state.selectedKey = entries[0]?.key || '';
    const selected = entries.find((entry) => entry.key === state.selectedKey) || null;
    const conflicts = selected && state.conflictKey === selected.key ? inspectCultivationConflicts(lore.entries, selected) : [];
    const sceneId = String(timeline?.activeSceneId || '');
    const turnOverrides = getWorldSenseTurnOverrides(sceneId);
    const profile = getWorldSenseProfile();
    const index = getWorldSenseIndexState(timelineId);
    const dryRun = buildWorldSenseDryRun({ entries: lore.entries, metadata, receipt });
    root.innerHTML = render({ timelineId, timeline, lore, metadata, entries, selected, conflicts, profile, index, proposals, history, receipt, proposalRejections, dryRun, turnOverrides, sceneId, state });
    root.setAttribute('aria-busy', String(Boolean(state.busy)));
}

function render(view) {
    const { timeline, lore, metadata, entries, selected, conflicts, profile, index, proposals, history, receipt, proposalRejections, dryRun, turnOverrides, sceneId, state } = view;
    if (!timeline) return '<div class="remodel-world-sense-empty"><h3>No active Timeline</h3><p>Select a Timeline before configuring World Sense.</p></div>';
    const indexed = Object.keys(index?.hashes || {}).length;
    return `
        <header class="remodel-world-sense-head">
            <div><span class="remodel-world-sense-kicker">Timeline intelligence</span><h2>World Sense</h2><p>${escapeHtml(timeline.title || 'Untitled Timeline')} · ${escapeHtml(lore.book || 'No Living Lore book assigned')}</p></div>
            <div class="remodel-world-sense-mode">
                <label>Mode<select data-ws-profile="mode">${WORLD_SENSE_MODES.map((mode) => `<option value="${mode}" ${profile.mode === mode ? 'selected' : ''}>${modeLabel(mode)}</option>`).join('')}</select></label>
                <span class="remodel-world-sense-mode-note">${modeNote(profile.mode)}</span>
            </div>
        </header>
        ${state.message ? `<div class="remodel-world-sense-notice" role="status">${escapeHtml(state.message)}</div>` : ''}
        <section class="remodel-world-sense-status" aria-label="World Sense status">
            <div><span>Local model</span><strong>${escapeHtml(profile.modelId)}</strong><small>Hugging Face embeddings</small></div>
            <div><span>Index</span><strong class="is-${escapeAttribute(index?.status || 'idle')}">${escapeHtml(index?.status || 'idle')}</strong><small>${indexed}/${lore.entries.length} entries · ${escapeHtml(relativeTime(index?.indexedAt))}</small></div>
            <div><span>Last retrieval</span><strong>${receipt ? `${receipt.selected?.length || 0} selected` : 'No receipt'}</strong><small>${receipt ? `${receipt.elapsedMs || 0} ms · ${receipt.degraded ? 'keyword fallback' : 'hybrid'}` : 'Run a scene or search below'}</small></div>
            <button type="button" data-ws-action="reindex" ${state.busy ? 'disabled' : ''}><i class="fa-solid fa-arrows-rotate"></i><span>${state.busy === 'index' ? 'Indexing…' : 'Reindex'}</span></button>
        </section>
        <details class="remodel-world-sense-settings">
            <summary>Model and retrieval limits</summary>
            <div>
                <label>Model<input type="text" value="${escapeAttribute(profile.modelId)}" data-ws-profile="modelId"></label>
                <label>Entry budget<input type="number" min="1" max="50" value="${profile.maxEntries}" data-ws-profile="maxEntries"></label>
                <label>Token budget<input type="number" min="100" max="12000" value="${profile.maxTokens}" data-ws-profile="maxTokens"></label>
                <label>Semantic floor<input type="number" min="0" max="1" step="0.05" value="${profile.semanticThreshold}" data-ws-profile="semanticThreshold"></label>
                <label>Auto-safe confidence<input type="number" min="0.5" max="1" step="0.01" value="${profile.autoSafeConfidence}" data-ws-profile="autoSafeConfidence"></label>
            </div>
            <fieldset class="remodel-world-sense-auto-safe"><legend>Auto-safe allowlist</legend>${AUTO_SAFE_OPERATIONS.map((operation) => `<label><input type="checkbox" value="${operation}" data-ws-auto-safe-op ${profile.autoSafeOperations.includes(operation) ? 'checked' : ''}> ${operation}</label>`).join('')}<small>Identity, premise, creation, retirement, deletion, low-confidence, conflicting, and sensitive changes always remain in review.</small></fieldset>
        </details>
        <div class="remodel-world-sense-grid">
            <section class="remodel-world-sense-browser" aria-label="Living Lore browser">
                <form data-ws-search-form class="remodel-world-sense-search">
                    <label><span class="sr-only">Search Living Lore</span><i class="fa-solid fa-magnifying-glass"></i><input value="${escapeAttribute(state.query)}" data-ws-search placeholder="Who controls shipping near the old harbor?"></label>
                    <button type="submit" ${state.busy ? 'disabled' : ''}>${state.busy === 'search' ? 'Searching…' : 'Semantic search'}</button>
                </form>
                <div class="remodel-world-sense-filters">
                    <label>Type<select data-ws-filter="type"><option value="all">All types</option>${LIVING_LORE_ENTRY_TYPES.map((type) => `<option value="${type}" ${state.type === type ? 'selected' : ''}>${title(type)}</option>`).join('')}</select></label>
                    <label>Status<select data-ws-filter="status">${['all', 'selected', 'pinned', 'excluded'].map((status) => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${title(status)}</option>`).join('')}</select></label>
                    <span>${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
                </div>
                <div class="remodel-world-sense-entry-list" role="listbox" aria-label="Living Lore entries">
                    ${entries.length ? entries.map((entry) => renderEntry(entry, state.selectedKey)).join('') : '<div class="remodel-world-sense-empty compact">No entries match these filters.</div>'}
                </div>
            </section>
            <section class="remodel-world-sense-inspector" aria-label="Living Lore inspector">
                ${selected ? renderInspector(selected, { turnOverrides, sceneId, allEntries: lore.entries, conflicts, draft: state.cultivationDraft }) : '<div class="remodel-world-sense-empty"><h3>Select an entry</h3><p>Inspect retrieval evidence, protection and links here.</p></div>'}
            </section>
        </div>
        <section class="remodel-world-sense-review-grid">
            <div class="remodel-world-sense-review" data-ws-review="proposals"><header><div><span>Review queue</span><strong>${proposals.length} suggestion${proposals.length === 1 ? '' : 's'}</strong></div>${proposals.length ? `<button type="button" data-ws-review-action="apply-all" ${proposals.length > 12 ? 'disabled title="Apply at most 12 proposals in one atomic transaction"' : ''}>Apply all</button>` : ''}</header>${proposals.length ? proposals.map((record) => renderProposal(record, state.proposalErrors?.[record.id])).join('') : '<p class="remodel-world-sense-muted">Accepted fiction has not produced any pending lore changes.</p>'}</div>
            <div class="remodel-world-sense-review"><header><div><span>Change history</span><strong>${history.length} transaction${history.length === 1 ? '' : 's'}</strong></div></header>${history.length ? history.map(renderHistory).join('') : '<p class="remodel-world-sense-muted">Applied proposal transactions will appear here.</p>'}</div>
        </section>
        <section class="remodel-world-sense-review remodel-world-sense-promotions" aria-label="Promotion detector activity">
            <header><div><span>Promotion detector</span><strong>${receipt?.promotion?.candidates?.length || 0} candidate${receipt?.promotion?.candidates?.length === 1 ? '' : 's'}</strong></div></header>
            ${(receipt?.promotion?.candidates || []).length ? receipt.promotion.candidates.map((candidate) => renderPromotionCandidate(candidate, receipt.promotionDecision)).join('') : '<p class="remodel-world-sense-muted">No accumulated Archive pattern is strong enough to ask the Loom about yet.</p>'}
            ${proposalRejections.length ? `<details class="remodel-world-sense-rejections"><summary>${proposalRejections.reduce((count, record) => count + record.items.length, 0)} recent proposal rejection${proposalRejections.reduce((count, record) => count + record.items.length, 0) === 1 ? '' : 's'}</summary>${proposalRejections.map(renderProposalRejectionRecord).join('')}</details>` : ''}
        </section>
        <details class="remodel-world-sense-dryrun">
            <summary><span>Prompt dry run</span><strong>${dryRun.entries.length} entr${dryRun.entries.length === 1 ? 'y' : 'ies'} · ${dryRun.budget?.usedTokens || 0}/${dryRun.budget?.maxTokens || profile.maxTokens} tokens</strong></summary>
            <p>This is the bounded Living Lore packet selected for the latest Preview/Narrator/Loom pass.</p>
            ${dryRun.entries.map((entry) => `<article><header><strong>${escapeHtml(entry.name)}</strong><span>rev ${entry.revision}</span></header><small>${escapeHtml(entry.reasons.join(' · ') || 'forced selection')}</small><pre>${escapeHtml(entry.content)}</pre></article>`).join('') || '<p class="remodel-world-sense-muted">No retrieval receipt exists for this Timeline yet.</p>'}
        </details>
    `;
}

function renderProposalRejectionRecord(record) {
    return `<article class="remodel-world-sense-proposal is-rejected">
        <header><div><span>${escapeHtml(record.phase || 'proposal')}</span><strong>${escapeHtml(relativeTime(record.at))}</strong></div><em>Rejected</em></header>
        ${(record.items || []).map((item) => `<div class="remodel-world-sense-rejection-item"><b>${escapeHtml(item.operation || 'Unknown operation')}${item.target ? ` · ${escapeHtml(item.target)}` : ''}</b><p>${escapeHtml(proposalRejectionMessage(item.code))}</p>${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ''}${item.evidence?.length ? `<small>Evidence: ${item.evidence.map(escapeHtml).join(' · ')}</small>` : ''}</div>`).join('')}
    </article>`;
}

function proposalRejectionMessage(code) {
    const messages = {
        'unsupported-evidence': 'The evidence did not match accepted prose, a committed Archive fact, or an approved owner instruction.',
        'missing-evidence': 'No independently checkable evidence was supplied.',
        'stale-revision': 'The target lore entry changed after this proposal was drafted.',
        'unselected-target': 'The proposal targeted lore that was not selected for this turn.',
        'wrong-book': 'The proposal targeted a different Timeline lorebook.',
        'book-unavailable': 'The Timeline lorebook could not be loaded.',
    };
    return messages[code] || `Rejected by the Living Lore contract: ${String(code || 'unknown reason').replaceAll('-', ' ')}.`;
}

function renderPromotionCandidate(candidate, receipt) {
    const evidence = (candidate.evidence || []).map((item) => item.text).filter(Boolean).slice(0, 2);
    const decision = (receipt?.decisions || []).find((item) => item.candidateId === candidate.id);
    const missing = (receipt?.rejections || []).some((item) => item.candidateId === candidate.id && item.code === 'missing-decision');
    return `<article class="remodel-world-sense-proposal">
        <header><div><span>${escapeHtml(title(candidate.kind || 'candidate'))}</span><strong>${escapeHtml(candidate.subject || 'Archive pattern')}</strong></div><em>${decision ? escapeHtml(title(decision.decision)) : missing ? 'Not answered' : `${Number(candidate.occurrences || 0)} records · ${Number(candidate.sceneCount || 0)} scenes`}</em></header>
        <p>${escapeHtml(candidate.rationale || '')}</p>
        ${decision ? `<small>${escapeHtml(decision.reason)}</small>` : ''}
        ${evidence.length ? `<small>${evidence.map(escapeHtml).join(' · ')}</small>` : ''}
    </article>`;
}

function renderEntry(entry, selectedKey) {
    const reasons = describeWorldSenseReasons(entry.reasons);
    return `<button type="button" role="option" aria-selected="${entry.key === selectedKey}" class="remodel-world-sense-entry ${entry.key === selectedKey ? 'is-selected' : ''}" data-ws-entry="${escapeAttribute(entry.key)}">
        <span class="remodel-world-sense-entry-top"><strong>${escapeHtml(entry.name)}</strong><em>${escapeHtml(entry.entryType)}</em></span>
        <span class="remodel-world-sense-entry-keys">${escapeHtml([...entry.keys, ...entry.secondaryKeys].slice(0, 5).join(' · ') || 'No keys')}</span>
        <span class="remodel-world-sense-entry-reason">${entry.selected ? `<b>${entry.score} pts</b> ${escapeHtml(reasons.join(' · '))}` : entry.semanticScore != null ? `<b>${Math.round(entry.semanticScore * 100)}%</b> semantic match` : escapeHtml(entry.decision || 'Not selected last turn')}</span>
        <span class="remodel-world-sense-entry-flags">${entry.pinned ? '<i class="fa-solid fa-thumbtack" title="Pinned"></i>' : ''}${entry.excluded ? '<i class="fa-solid fa-eye-slash" title="Excluded"></i>' : ''}${entry.protectedFields.length ? `<i class="fa-solid fa-lock" title="${entry.protectedFields.length} protected fields"></i>` : ''}<span>rev ${entry.revision}</span></span>
    </button>`;
}

function renderInspector(entry, { turnOverrides, sceneId, allEntries, conflicts, draft }) {
    const reasons = describeWorldSenseReasons(entry.reasons);
    const nextPinned = turnOverrides.pins.some((item) => `${item.book}.${item.uid}` === entry.key);
    const nextExcluded = turnOverrides.excludes.some((item) => `${item.book}.${item.uid}` === entry.key);
    const protection = seedProtectionSummary(entry.metadata);
    return `<form data-ws-metadata-form data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}">
        <header><div><span>${escapeHtml(entry.book)} · ${escapeHtml(entry.uid)}</span><h3>${escapeHtml(entry.name)}</h3></div><span class="remodel-world-sense-revision">rev ${entry.revision}</span></header>
        <p class="remodel-world-sense-evidence">${reasons.length ? `<b>Why it matched:</b> ${escapeHtml(reasons.join(' · '))}` : 'This entry was not part of the latest retrieval.'}</p>
        <div class="remodel-world-sense-meta-row"><label>Entry type<select name="entryType">${LIVING_LORE_ENTRY_TYPES.map((type) => `<option value="${type}" ${entry.entryType === type ? 'selected' : ''}>${title(type)}</option>`).join('')}</select></label><label>Origin<input value="${escapeAttribute(entry.origin)}" disabled></label></div>
        <fieldset><legend>Next turn</legend><button type="button" data-ws-turn="${nextPinned ? 'clear' : 'pin'}" data-scene="${escapeAttribute(sceneId)}" data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}" class="${nextPinned ? 'is-active' : ''}" ${sceneId ? '' : 'disabled'}><i class="fa-solid fa-thumbtack"></i> ${nextPinned ? 'Pinned for next turn' : 'Pin for next turn'}</button><button type="button" data-ws-turn="${nextExcluded ? 'clear' : 'exclude'}" data-scene="${escapeAttribute(sceneId)}" data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}" class="${nextExcluded ? 'is-active' : ''}" ${sceneId ? '' : 'disabled'}><i class="fa-solid fa-eye-slash"></i> ${nextExcluded ? 'Excluded next turn' : 'Exclude next turn'}</button></fieldset>
        <fieldset><legend>Persistent handling</legend><label><input type="checkbox" name="pinned" ${entry.pinned ? 'checked' : ''}> Always pin</label><label><input type="checkbox" name="excluded" ${entry.excluded ? 'checked' : ''}> Always exclude</label></fieldset>
        <fieldset class="remodel-world-sense-protection"><legend>Protected fields</legend>${LIVING_LORE_PROTECTED_FIELDS.map((field) => `<label><input type="checkbox" name="protectedFields" value="${field}" ${entry.protectedFields.includes(field) ? 'checked' : ''}> ${humanField(field)}</label>`).join('')}</fieldset>
        ${entry.entryType === 'seed' ? `<div class="remodel-world-sense-seed-locks"><span>Seed contract</span><b>${protection.premiseProtected ? 'Premise locked' : 'Premise editable with review'}</b><b>${protection.hooksProtected ? 'Open hooks locked' : 'Open hooks may grow'}</b><small>Identity + Established protect the premise. Open threads control expandable hooks.</small></div>` : ''}
        <div class="remodel-world-sense-links"><span>Related entries</span>${entry.links.length ? entry.links.map((link) => `<span>${escapeHtml(link.relation)} → ${escapeHtml(link.target.book)} · ${escapeHtml(link.target.uid)}</span>`).join('') : '<em>No typed links yet</em>'}</div>
        <button type="submit">Save metadata and protection</button>
    </form>${renderCultivation(entry, { allEntries, conflicts, draft })}`;
}

function renderCultivation(entry, { allEntries, conflicts, draft }) {
    const linkOptions = (allEntries || []).filter((item) => `${item.book}.${item.uid}` !== entry.key).map((item) => `<option value="${escapeAttribute(item.uid)}">${escapeHtml(item.name || `Entry ${item.uid}`)}</option>`).join('');
    const belongsToEntry = draft?.entryKey === entry.key;
    return `<section class="remodel-world-sense-cultivation" aria-label="Cultivate Living Lore">
        <header><div><span>Directed cultivation</span><h3>Grow with intent</h3></div><small>Drafts only. Review is required.</small></header>
        <div class="remodel-world-sense-cultivation-actions"><button type="button" data-ws-cultivate="grow">Grow this seed</button><button type="button" data-ws-cultivate="related">Find related lore</button><button type="button" data-ws-cultivate="contradictions">Check contradictions</button><button type="button" data-ws-cultivate="update">Update from scene</button></div>
        <form data-ws-cultivation-form data-book="${escapeAttribute(entry.book)}" data-uid="${escapeAttribute(entry.uid)}">
            <label>Pointed action<select name="action"><option value="grow">Add open hook</option><option value="establish">Add established fact</option><option value="update">Set current state</option><option value="create">Create related entry</option><option value="link">Link another entry</option></select></label>
            <label>Entry type<select name="entryType">${LIVING_LORE_ENTRY_TYPES.map((type) => `<option value="${type}" ${type === entry.entryType ? 'selected' : ''}>${title(type)}</option>`).join('')}</select></label>
            <label class="wide">Instruction or exact proposed text<textarea name="value" rows="3" placeholder="State exactly what should be proposed. This is treated as owner instruction, not accepted fiction."></textarea></label>
            <label>Link target<select name="linkUid"><option value="">Choose an entry</option>${linkOptions}</select></label>
            <label>Relationship<input name="relation" value="related"></label>
            <button type="submit">Preview proposal</button>
        </form>
        ${belongsToEntry ? renderCultivationDraft(draft) : ''}
        ${conflicts.length ? `<div class="remodel-world-sense-conflicts"><strong>${conflicts.length} warning${conflicts.length === 1 ? '' : 's'}</strong>${conflicts.map((item) => `<article class="is-${escapeAttribute(item.kind)}"><b>${escapeHtml(item.kind.replaceAll('-', ' '))}</b><span>${escapeHtml(item.name || item.target.uid)}</span><p>${escapeHtml(item.detail)}</p></article>`).join('')}</div>` : ''}
    </section>`;
}

function renderCultivationDraft(draft) {
    if (!draft?.result?.ok) return `<div class="remodel-world-sense-cultivation-preview is-error">Draft refused: ${escapeHtml(draft?.result?.code || 'invalid proposal')}</div>`;
    const proposal = draft.result.proposal;
    return `<div class="remodel-world-sense-cultivation-preview"><header><strong>Proposal preview</strong><span>${escapeHtml(proposal.operation)}</span></header><p>${escapeHtml(typeof proposal.value === 'string' ? proposal.value : JSON.stringify(proposal.value))}</p><small>No lore has been changed.</small><button type="button" class="primary" data-ws-cultivation-queue>Send to review queue</button></div>`;
}

function renderProposal(record, error = '') {
    const rows = proposalDiffRows(record);
    const operation = record.proposal?.operation || 'change';
    return `<article class="remodel-world-sense-proposal"><header><div><strong>${escapeHtml(operation)}</strong><span>${escapeHtml(record.book)} · ${escapeHtml(record.proposal?.target?.uid ?? 'new')}</span></div><time>${escapeHtml(relativeTime(record.createdAt))}</time></header>
        <div class="remodel-world-sense-diff">${rows.map((row) => `<div><span>${escapeHtml(row.field)}</span><del>${escapeHtml(row.before || '—')}</del><ins>${escapeHtml(row.after || '—')}</ins></div>`).join('')}</div>
        <small>Evidence: ${escapeHtml(record.evidence?.source || record.source?.stage || 'accepted fiction')}</small>
        ${error ? `<p class="remodel-world-sense-proposal-error" role="alert">${escapeHtml(proposalRejectionMessage(error))}</p>` : ''}
        <footer><button type="button" data-ws-proposal="edit" data-id="${escapeAttribute(record.id)}">Edit</button><button type="button" data-ws-proposal="reject" data-id="${escapeAttribute(record.id)}">Reject</button><button type="button" data-ws-proposal="safe" data-id="${escapeAttribute(record.id)}" ${SAFE_OPERATIONS.has(operation) ? '' : 'disabled'}>Apply safe</button><button type="button" class="primary" data-ws-proposal="apply" data-id="${escapeAttribute(record.id)}">Apply</button></footer>
    </article>`;
}

function renderHistory(transaction) {
    return `<article class="remodel-world-sense-history"><div><strong>${transaction.diffs?.length || 0} field change${transaction.diffs?.length === 1 ? '' : 's'}</strong><span>${escapeHtml(relativeTime(transaction.appliedAt))} · ${escapeHtml(transaction.status)}</span></div><button type="button" data-ws-rollback="${escapeAttribute(transaction.id)}" ${transaction.status === 'applied' ? '' : 'disabled'}>Rollback</button></article>`;
}

function bind(root, state) {
    state.bound = true;
    root.addEventListener('click', async (event) => {
        const entry = event.target.closest?.('[data-ws-entry]');
        if (entry) { state.selectedKey = entry.dataset.wsEntry; state.cultivationDraft = null; state.conflictKey = ''; await refresh(root, state); return; }
        const cultivate = event.target.closest?.('[data-ws-cultivate]')?.dataset.wsCultivate;
        if (cultivate) { await handleCultivationShortcut(root, state, cultivate); return; }
        if (event.target.closest?.('[data-ws-cultivation-queue]')) { await queueCultivationDraft(root, state); return; }
        const action = event.target.closest?.('[data-ws-action]')?.dataset.wsAction;
        if (action === 'reindex') await act(root, state, 'index', async () => ensureWorldSenseIndex(getTimelineStore().activeTimelineId, { force: true }), 'Index rebuilt.');
        const proposal = event.target.closest?.('[data-ws-proposal]');
        if (proposal) await handleProposal(root, state, proposal.dataset.wsProposal, proposal.dataset.id);
        const reviewAction = event.target.closest?.('[data-ws-review-action]')?.dataset.wsReviewAction;
        if (reviewAction === 'apply-all') await applyAllProposals(root, state);
        const rollback = event.target.closest?.('[data-ws-rollback]');
        if (rollback) await act(root, state, 'rollback', () => rollbackLivingLoreTransaction({ timelineId: getTimelineStore().activeTimelineId, transactionId: rollback.dataset.wsRollback }), 'Transaction rolled back.');
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
        if (event.target.matches('[data-ws-auto-safe-op]')) {
            const operations = [...root.querySelectorAll('[data-ws-auto-safe-op]:checked')].map((input) => input.value);
            updateWorldSenseProfile({ autoSafeOperations: operations });
            state.message = 'Auto-safe allowlist saved. Empty means every proposal stays in review.';
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
            if (!state.query) { state.semanticMatches = []; await refresh(root, state); return; }
            await act(root, state, 'search', async () => {
                const result = await queryWorldSense(getTimelineStore().activeTimelineId, state.query, { topK: 30, threshold: 0 });
                state.semanticMatches = result.matches || [];
                if (!result.ok) throw new Error(result.error || 'Semantic search unavailable.');
                return result;
            }, 'Semantic search completed.');
            return;
        }
        if (event.target.matches('[data-ws-metadata-form]')) {
            event.preventDefault();
            const form = event.target;
            const fields = [...form.querySelectorAll('[name="protectedFields"]:checked')].map((input) => input.value);
            upsertLivingLoreMetadata(getTimelineStore().activeTimelineId, { book: form.dataset.book, uid: form.dataset.uid }, {
                entryType: form.elements.entryType.value,
                protectedFields: fields,
                worldSense: { pinned: form.elements.pinned.checked, excluded: form.elements.excluded.checked },
            });
            state.message = 'Entry metadata and protection saved.';
            await refresh(root, state);
            return;
        }
        if (event.target.matches('[data-ws-cultivation-form]')) {
            event.preventDefault();
            const form = event.target;
            const view = await cultivationContext(form.dataset.uid);
            const linkTarget = view.lore.entries.find((item) => String(item.uid) === String(form.elements.linkUid.value)) || null;
            if (linkTarget) linkTarget.metadata = view.metadata.find((item) => `${item.book}.${item.uid}` === `${linkTarget.book}.${linkTarget.uid}`);
            const result = draftCultivationProposal({
                action: form.elements.action.value, book: view.lore.book, entry: view.entry, metadata: view.entryMetadata,
                value: form.elements.value.value, entryType: form.elements.entryType.value, linkTarget, relation: form.elements.relation.value,
            });
            state.cultivationDraft = { entryKey: `${view.entry.book}.${view.entry.uid}`, result, instruction: form.elements.value.value.trim(), lore: view.lore, metadata: view.metadata };
            state.message = result.ok ? 'Proposal drafted. Review the exact operation before queueing it.' : `Cultivation draft refused: ${result.code}.`;
            await refresh(root, state);
        }
    });
}

async function applyAllProposals(root, state) {
    const timelineId = getTimelineStore().activeTimelineId;
    const proposalIds = listLivingLoreProposals({ timelineId, status: 'suggested' }).map((record) => record.id);
    if (!proposalIds.length) return;
    if (proposalIds.length > 12) {
        state.message = 'Apply all supports at most 12 proposals in one atomic transaction.';
        await refresh(root, state);
        return;
    }
    return act(root, state, 'proposal', () => applyLivingLoreProposals({
        timelineId,
        proposalIds,
        application: { authority: 'owner-review', bulk: true },
    }), `${proposalIds.length} lore changes applied in one transaction.`);
}

async function handleCultivationShortcut(root, state, action) {
    const timelineId = getTimelineStore().activeTimelineId;
    const lore = await loadTimelineLore(timelineId);
    const selected = lore.entries.find((entry) => `${entry.book}.${entry.uid}` === state.selectedKey);
    if (!selected) return;
    if (action === 'related') {
        state.query = cultivationSearchText(selected);
        return act(root, state, 'search', async () => {
            const result = await queryWorldSense(timelineId, state.query, { topK: 30, threshold: 0 });
            state.semanticMatches = (result.matches || []).filter((item) => `${item.book}.${item.uid}` !== state.selectedKey);
            if (!result.ok) throw new Error(result.error || 'Semantic search unavailable.');
            return result;
        }, 'Related lore ranked. Results include semantic evidence, not automatic links.');
    }
    if (action === 'contradictions') {
        state.conflictKey = state.selectedKey;
        state.message = 'Deterministic duplicate and contradiction checks completed.';
        await refresh(root, state);
        return;
    }
    const form = root.querySelector('[data-ws-cultivation-form]');
    if (form) { form.elements.action.value = action; form.elements.value.focus(); }
}

async function cultivationContext(uid) {
    const timelineId = getTimelineStore().activeTimelineId;
    const lore = await loadTimelineLore(timelineId);
    const metadata = listLivingLoreMetadata({ timelineId, book: lore.book || '' });
    const entry = lore.entries.find((item) => String(item.uid) === String(uid));
    const entryMetadata = metadata.find((item) => `${item.book}.${item.uid}` === `${entry?.book}.${entry?.uid}`);
    return { timelineId, lore, metadata, entry, entryMetadata };
}

async function queueCultivationDraft(root, state) {
    const draft = state.cultivationDraft;
    if (!draft?.result?.ok) return;
    const timelineId = getTimelineStore().activeTimelineId;
    const proposal = draft.result.proposal;
    const packet = buildCultivationPacket({ timelineId, book: draft.lore.book, bookHash: draft.lore.hash, entries: draft.lore.entries, metadata: draft.metadata, proposal });
    await act(root, state, 'proposal', () => queueLivingLoreProposals({
        timelineId, packet, proposals: [proposal], explicitInstructions: [proposal.evidence, draft.instruction].filter(Boolean),
        source: { authority: 'owner', stage: 'cultivation' },
    }), 'Cultivation proposal added to the review queue.');
    state.cultivationDraft = null;
    await refresh(root, state);
}

async function handleProposal(root, state, action, id) {
    const timelineId = getTimelineStore().activeTimelineId;
    state.proposalErrors ??= {};
    if (action === 'reject') return act(root, state, 'proposal', () => rejectLivingLoreProposal({ timelineId, proposalId: id }), 'Suggestion rejected.', { proposalId: id });
    if (action === 'apply') return act(root, state, 'proposal', () => applyLivingLoreProposals({ timelineId, proposalIds: [id], application: { authority: 'owner-review' } }), 'Lore change applied.', { proposalId: id });
    if (action === 'safe') return act(root, state, 'proposal', async () => {
        const result = await applyAutoSafeLivingLoreProposals({ timelineId, proposalIds: [id], manual: true });
        if (result.ok && !result.applied?.length) return { ok: false, code: `Not safe to apply: ${result.review?.[0]?.reason || 'policy refused it'}` };
        return result;
    }, 'Lore change passed the safe policy and was applied.', { proposalId: id });
    if (action === 'edit') {
        const record = listLivingLoreProposals({ timelineId }).find((item) => item.id === id);
        if (!record) return;
        const original = typeof record.proposal?.value === 'string' ? record.proposal.value : JSON.stringify(record.proposal?.value ?? '', null, 2);
        const edited = window.prompt('Edit the proposed value. The target, operation and evidence remain locked.', original);
        if (edited == null || edited === original) return;
        let value = edited;
        if (typeof record.proposal?.value !== 'string') {
            try { value = JSON.parse(edited); } catch { state.message = 'That proposal value must remain valid JSON.'; await refresh(root, state); return; }
        }
        return act(root, state, 'proposal', () => editLivingLoreProposalValue({ timelineId, proposalId: id, value }), 'Suggestion edited and revalidated.', { proposalId: id });
    }
}

async function act(root, state, busy, task, success, { proposalId = '' } = {}) {
    state.busy = busy;
    state.message = '';
    await refresh(root, state);
    try {
        const result = await task();
        if (result?.ok === false) throw new Error(result.code || result.error || result.state?.error || 'The operation could not be completed.');
        if (proposalId && state.proposalErrors) delete state.proposalErrors[proposalId];
        state.message = success;
    } catch (error) {
        state.message = String(error?.message || error);
        if (proposalId) (state.proposalErrors ??= {})[proposalId] = state.message;
    } finally {
        state.busy = '';
        await refresh(root, state);
    }
}

function modeLabel(mode) { return title(mode); }
function modeNote(mode) {
    if (mode === 'off') return 'Native World Info continues without semantic retrieval.';
    if (mode === 'observe') return 'Retrieves relevant lore but creates no proposals.';
    if (mode === 'auto-safe') return 'Applies only allowlisted, high-confidence changes backed by accepted fiction; every other change stays in review.';
    return 'Retrieves lore and queues changes for your review.';
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
function humanField(value) { return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]); }
function escapeAttribute(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
