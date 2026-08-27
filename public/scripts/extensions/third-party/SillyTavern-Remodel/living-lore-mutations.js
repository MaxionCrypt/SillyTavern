import { getContext } from '../../../st-context.js';
import { recordDebugEvent } from './debug-console.js';
import {
    loreEntryKey,
    normalizeLivingLoreLink,
    normalizeLivingLoreMetadata,
} from './living-lore-model.js';
import {
    getTimelineLivingLoreState,
    saveLivingLoreStore,
} from './living-lore-store.js';
import { parseLivingLoreProposals } from './living-lore-proposals.js';
import { classifyAutoSafeProposals } from './living-lore-auto-safe.js';
import { invalidateTimelineLoreCache } from './world-sense-lore.js';
import { getWorldSenseProfile } from './world-sense-store.js';

const MODE = 'suggest';
const MAX_PROPOSALS_PER_TRANSACTION = 12;
const MAX_VALUE_CHARS = 6000;
const MAX_ENTRY_CHARS = 12000;
const MAX_ENTRY_TOKENS = 3000;
const HISTORY_LIMIT = 500;
const SECTION_NAMES = Object.freeze(['Identity', 'Established', 'Current', 'Open threads', 'Retirement']);
const PROTECTED_BY_OPERATION = Object.freeze({
    'fact.append': ['established'],
    'current.set': ['current'],
    'thread.add': ['openThreads'],
    'alias.add': ['primaryKeys'],
    'entry.link': [],
    'entry.retire': ['retirement', 'nativeSettings'],
    'entry.create': [],
});

/**
 * Validate detached Loom proposals and persist field-level suggestions. No
 * native World Info write occurs here; accepted-fiction lifecycle ownership is
 * deliberately left to the caller (Commit 9).
 */
export async function queueLivingLoreProposals({
    timelineId = '', packet = null, proposals = [], acceptedProse = '', archiveFacts = [], promotionFacts = [], explicitInstructions = [], source = {},
} = {}) {
    const automationMode = getWorldSenseProfile().mode || 'suggest';
    if (automationMode === 'off' || automationMode === 'observe') {
        return { ok: true, queued: [], rejected: [], observed: automationMode === 'observe' };
    }
    const bucket = getTimelineLivingLoreState(timelineId);
    if (!bucket || !packet?.book) return { ok: false, queued: [], rejected: [{ index: -1, code: 'missing-context' }] };
    const context = getContext();
    const data = await context.loadWorldInfo?.(packet.book);
    if (!data?.entries) return { ok: false, queued: [], rejected: [{ index: -1, code: 'book-unavailable' }] };

    const queued = [];
    const rejected = [];
    for (let index = 0; index < (Array.isArray(proposals) ? proposals.length : 0); index += 1) {
        const proposal = proposals[index];
        const parsed = parseLivingLoreProposals([proposal], packet);
        if (parsed.rejected.length) {
            rejected.push({ index, code: parsed.rejected[0].code, proposal: clone(proposal) });
            continue;
        }
        const proposalIdentity = String(proposal.id || '').trim() || stableHash(proposal);
        const idempotencyKey = String(source?.directionId || '').trim()
            ? `${String(source.directionId).trim()}:${proposalIdentity}`
            : '';
        const existing = idempotencyKey
            ? Object.values(bucket.proposals).find((record) => record.idempotencyKey === idempotencyKey)
            : null;
        // A completed identity is already settled. In particular, a proposal
        // that was applied at revision 1 must not be reclassified as stale
        // when reload sees the entry at revision 2.
        if (existing && existing.status !== 'invalidated') {
            existing.source = { ...existing.source, ...clone(source), proposalId: proposalIdentity };
            queued.push(clone(existing));
            continue;
        }
        const code = validateSuggestion(proposal, { timelineId, bucket, data, acceptedProse, archiveFacts, promotionFacts, explicitInstructions, source });
        if (code) {
            rejected.push({ index, code, proposal: clone(proposal) });
            continue;
        }
        const preview = previewProposal(data, bucket, proposal);
        if (!preview.ok) {
            rejected.push({ index, code: preview.code, proposal: clone(proposal) });
            continue;
        }
        if (existing) {
            existing.source = { ...existing.source, ...clone(source), proposalId: proposalIdentity };
            if (existing.status === 'invalidated' && source?.reactivate) {
                existing.status = 'suggested';
                existing.invalidatedAt = null;
                existing.invalidationReason = '';
                existing.updatedAt = now();
            }
            queued.push(clone(existing));
            continue;
        }
        const timestamp = now();
        const id = uniqueProposalId(bucket, String(proposal.id || '').trim() || makeId('lore-proposal'));
        const record = {
            id,
            mode: MODE,
            status: 'suggested',
            timelineId: String(timelineId),
            book: String(packet.book),
            packetBookHash: String(packet.bookHash || ''),
            idempotencyKey,
            proposal: clone(proposal),
            diff: preview.diff,
            evidence: { matched: true, source: evidenceSource(proposal.evidence, acceptedProse, archiveFacts, promotionFacts, explicitInstructions, source) },
            source: { ...clone(source), proposalId: proposalIdentity },
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        bucket.proposals[id] = record;
        bucket.book ||= String(packet.book);
        queued.push(clone(record));
    }
    bucket.updatedAt = now();
    saveLivingLoreStore();
    debug('proposal.queued', { timelineId, book: packet.book, queued: queued.length, rejected }, rejected.length ? 'warn' : 'info');
    const autoSafe = automationMode === 'auto-safe'
        ? await applyAutoSafeLivingLoreProposals({ timelineId, proposalIds: queued.map((record) => record.id) })
        : { ok: true, applied: [], review: [] };
    const canonicalBucket = getTimelineLivingLoreState(timelineId, { create: false });
    const refreshed = queued.map((record) => clone(canonicalBucket?.proposals?.[record.id] || record));
    return { ok: rejected.length === 0, queued: refreshed, rejected, autoSafe };
}

/** Invalidate only unapplied suggestions belonging to superseded fiction. */
export function invalidateLivingLoreProposals({ timelineId = '', directionIds = [], messageIds = [], reason = 'superseded' } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    if (!bucket) return { invalidated: [] };
    const directions = new Set(uniqueStrings(directionIds));
    const messages = new Set((Array.isArray(messageIds) ? messageIds : []).map((value) => String(value)));
    const invalidated = [];
    const timestamp = now();
    for (const record of Object.values(bucket.proposals || {})) {
        if (record.status !== 'suggested') continue;
        const matchesDirection = directions.size && directions.has(String(record.source?.directionId || ''));
        const matchesMessage = messages.size && messages.has(String(record.source?.messageId ?? ''));
        if (!matchesDirection && !matchesMessage) continue;
        record.status = 'invalidated';
        record.invalidationReason = String(reason || 'superseded');
        record.invalidatedAt = timestamp;
        record.updatedAt = timestamp;
        invalidated.push(record.id);
    }
    if (invalidated.length) {
        bucket.updatedAt = timestamp;
        saveLivingLoreStore();
        debug('proposal.invalidated', { timelineId, directionIds: [...directions], messageIds: [...messages], reason, proposalIds: invalidated }, 'warn');
    }
    return { invalidated };
}

export function listLivingLoreProposals({ timelineId = '', status = '' } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const records = Object.values(bucket?.proposals || {});
    return records.filter((record) => !status || record.status === status).map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listLivingLoreHistory({ timelineId = '' } = {}) {
    return (getTimelineLivingLoreState(timelineId, { create: false })?.history || []).map(clone);
}

/** Apply only proposals admitted by the pure Auto-safe policy. A failed batch
 * remains reviewable and never turns an otherwise successful roleplay save
 * into a generation failure. */
export async function applyAutoSafeLivingLoreProposals({ timelineId = '', proposalIds = [] } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const ids = uniqueStrings(proposalIds);
    const records = ids.map((id) => bucket?.proposals?.[id]).filter(Boolean);
    const decision = classifyAutoSafeProposals(records, getWorldSenseProfile());
    if (!decision.eligible.length) {
        debug('auto-safe.review', { timelineId, review: decision.review, threshold: decision.threshold });
        return { ok: true, applied: [], review: decision.review, policy: decision };
    }
    const eligibleIds = decision.eligible.map((item) => item.id);
    const applied = await applyLivingLoreProposals({
        timelineId, proposalIds: eligibleIds,
        application: { authority: 'auto-safe', confidenceThreshold: decision.threshold, allowlist: decision.allowlist },
    });
    if (!applied.ok) {
        debug('auto-safe.failed', { timelineId, proposalIds: eligibleIds, code: applied.code, review: decision.review }, 'warn');
        return { ok: false, applied: [], review: [...decision.review, ...eligibleIds.map((id) => ({ id, reason: applied.code || 'apply-failed' }))], policy: decision, code: applied.code };
    }
    debug('auto-safe.applied', { timelineId, proposalIds: eligibleIds, transactionId: applied.transactionId, review: decision.review });
    return { ok: true, applied: eligibleIds, transactionId: applied.transactionId, review: decision.review, policy: decision };
}

export function rejectLivingLoreProposal({ timelineId = '', proposalId = '', reason = 'owner-rejected' } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const record = bucket?.proposals?.[String(proposalId)];
    if (!record || record.status !== 'suggested') return failure('proposal-unavailable');
    record.status = 'rejected';
    record.rejectionReason = String(reason || 'owner-rejected');
    record.updatedAt = now();
    bucket.updatedAt = record.updatedAt;
    saveLivingLoreStore();
    debug('proposal.rejected', { timelineId, proposalId: record.id, reason: record.rejectionReason });
    return { ok: true, proposalId: record.id };
}

/** Owner edits only the typed value. The operation, target, evidence and
 * revision remain fixed; the edited value is re-previewed against native lore
 * before it can replace the queued diff. */
export async function editLivingLoreProposalValue({ timelineId = '', proposalId = '', value } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const record = bucket?.proposals?.[String(proposalId)];
    if (!bucket || !record || record.status !== 'suggested') return failure('proposal-unavailable');
    const context = getContext();
    const data = await context.loadWorldInfo?.(record.book);
    if (!data?.entries) return failure('book-unavailable');
    const proposal = { ...clone(record.proposal), value: clone(value) };
    if (String(typeof value === 'string' ? value : JSON.stringify(value ?? '')).length > MAX_VALUE_CHARS) return failure('value-too-large');
    const validationCode = validateApply(proposal, bucket, data);
    if (validationCode) return failure(validationCode);
    const preview = previewProposal(data, bucket, proposal);
    if (!preview.ok) return failure(preview.code);
    record.proposal = proposal;
    record.diff = preview.diff;
    record.updatedAt = now();
    bucket.updatedAt = record.updatedAt;
    saveLivingLoreStore();
    debug('proposal.edited', { timelineId, proposalId: record.id });
    return { ok: true, proposal: clone(record) };
}

/** Apply an owner-selected suggestion set as one native World Info save. */
export async function applyLivingLoreProposals({ timelineId = '', proposalIds = [], application = {} } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const ids = uniqueStrings(proposalIds);
    if (!bucket || !ids.length) return failure('missing-proposals');
    if (ids.length > MAX_PROPOSALS_PER_TRANSACTION) return failure('transaction-too-large');
    const records = ids.map((id) => bucket.proposals[id]);
    if (records.some((record) => !record || record.status !== 'suggested')) return failure('proposal-unavailable');
    const books = uniqueStrings(records.map((record) => record.book));
    if (books.length !== 1 || books[0] !== bucket.book) return failure('mixed-books');

    const context = getContext();
    const original = await context.loadWorldInfo?.(bucket.book);
    if (!original?.entries || typeof context.saveWorldInfo !== 'function') return failure('book-unavailable');
    const working = clone(original);
    const metadataWorking = clone(bucket.entries || {});
    const touched = new Set();
    const diffs = [];

    // All stale/protection checks happen against the same pre-transaction
    // revision. Mutating a clone ensures a late failure cannot partly land.
    for (const record of records) {
        const proposal = record.proposal;
        const code = validateApply(proposal, bucket, original);
        if (code) return failure(code, { proposalId: record.id });
        const result = mutateProposal(working, metadataWorking, proposal);
        if (!result.ok) return failure(result.code, { proposalId: record.id });
        result.keys.forEach((key) => touched.add(key));
        diffs.push(...result.diff.map((item) => ({ proposalId: record.id, ...item })));
    }

    for (const key of touched) {
        const metadata = metadataWorking[key];
        if (!metadata) continue;
        const previous = bucket.entries[key];
        metadata.revision = previous ? Number(previous.revision || 1) + 1 : 1;
        metadata.updatedAt = now();
        metadata.createdAt ||= metadata.updatedAt;
    }
    const limitCode = validateBookLimits(working, touched);
    if (limitCode) return failure(limitCode);

    const affected = [...touched].map((key) => ({
        key,
        before: clone(findEntryByKey(original, key)),
        after: clone(findEntryByKey(working, key)),
        metadataBefore: clone(bucket.entries[key] || null),
        metadataAfter: clone(metadataWorking[key] || null),
    }));
    try {
        await context.saveWorldInfo(bucket.book, working, true);
    } catch (error) {
        // Native save updates its in-memory cache before awaiting the backend.
        // Restore the prior object even when the original write throws.
        try { await context.saveWorldInfo(bucket.book, clone(original), true); } catch { /* best effort; failure is still reported */ }
        debug('transaction.failed', { timelineId, book: bucket.book, code: 'save-failed', error: String(error?.message || error) }, 'error');
        return failure('save-failed', { error: String(error?.message || error) });
    }

    const timestamp = now();
    const transactionId = makeId('lore-transaction');
    bucket.entries = metadataWorking;
    for (const record of records) {
        record.status = 'applied';
        record.transactionId = transactionId;
        record.updatedAt = timestamp;
    }
    bucket.history.push({
        id: transactionId,
        status: 'applied',
        timelineId: String(timelineId),
        book: bucket.book,
        proposalIds: ids,
        diffs,
        affected,
        application: clone(application),
        appliedAt: timestamp,
        updatedAt: timestamp,
    });
    if (bucket.history.length > HISTORY_LIMIT) bucket.history.splice(0, bucket.history.length - HISTORY_LIMIT);
    bucket.updatedAt = timestamp;
    saveLivingLoreStore();
    invalidateTimelineLoreCache(bucket.book);
    debug('transaction.applied', { timelineId, book: bucket.book, transactionId, proposalIds: ids, diffs });
    return { ok: true, transactionId, proposalIds: ids, diffs: clone(diffs) };
}

export async function rollbackLivingLoreTransaction({ timelineId = '', transactionId = '' } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const transaction = bucket?.history?.find((item) => item.id === String(transactionId));
    if (!bucket || !transaction || transaction.status !== 'applied') return failure('transaction-unavailable');
    const context = getContext();
    const current = await context.loadWorldInfo?.(bucket.book);
    if (!current?.entries || typeof context.saveWorldInfo !== 'function') return failure('book-unavailable');

    for (const item of transaction.affected) {
        if (!sameData(findEntryByKey(current, item.key), item.after)) return failure('stale-rollback', { key: item.key });
        if (!sameData(bucket.entries[item.key] || null, item.metadataAfter)) return failure('stale-rollback', { key: item.key });
    }
    const restored = clone(current);
    for (const item of transaction.affected) replaceEntryByKey(restored, item.key, item.before);
    try {
        await context.saveWorldInfo(bucket.book, restored, true);
    } catch (error) {
        try { await context.saveWorldInfo(bucket.book, clone(current), true); } catch { /* best effort */ }
        return failure('save-failed', { error: String(error?.message || error) });
    }

    for (const item of transaction.affected) {
        if (item.metadataBefore) bucket.entries[item.key] = clone(item.metadataBefore);
        else delete bucket.entries[item.key];
    }
    const timestamp = now();
    transaction.status = 'rolled-back';
    transaction.rolledBackAt = timestamp;
    transaction.updatedAt = timestamp;
    for (const id of transaction.proposalIds) {
        if (!bucket.proposals[id]) continue;
        bucket.proposals[id].status = 'rolled-back';
        bucket.proposals[id].updatedAt = timestamp;
    }
    bucket.updatedAt = timestamp;
    saveLivingLoreStore();
    invalidateTimelineLoreCache(bucket.book);
    debug('transaction.rolled-back', { timelineId, book: bucket.book, transactionId });
    return { ok: true, transactionId: transaction.id };
}

function validateSuggestion(proposal, { timelineId, bucket, data, acceptedProse, archiveFacts, promotionFacts, explicitInstructions, source }) {
    if (String(proposal.value ?? '').length > MAX_VALUE_CHARS) return 'value-too-large';
    if (!evidenceSource(proposal.evidence, acceptedProse, archiveFacts, promotionFacts, explicitInstructions, source)) return 'unsupported-evidence';
    if (proposal.operation === 'entry.create') return '';
    const key = loreEntryKey(proposal.target);
    const metadata = bucket.entries[key] || normalizeLivingLoreMetadata({}, proposal.target);
    if (!metadata || Number(metadata.revision || 1) !== proposal.target.revision) return 'stale-revision';
    if (!findNativeEntry(data, proposal.target.uid)) return 'missing-entry';
    if (isProtected(metadata, proposal.operation)) return 'protected-field';
    if (proposal.operation === 'entry.link') {
        const targetMetadata = bucket.entries[loreEntryKey(proposal.value?.target)];
        if (!targetMetadata || targetMetadata.revision !== proposal.value.target.revision) return 'stale-link-revision';
    }
    void timelineId;
    return '';
}

function validateApply(proposal, bucket, data) {
    if (proposal.operation === 'entry.create') return '';
    const metadata = bucket.entries[loreEntryKey(proposal.target)];
    if (!metadata || metadata.revision !== proposal.target.revision) return 'stale-revision';
    if (!findNativeEntry(data, proposal.target.uid)) return 'missing-entry';
    if (isProtected(metadata, proposal.operation)) return 'protected-field';
    if (proposal.operation === 'entry.link') {
        const linked = bucket.entries[loreEntryKey(proposal.value?.target)];
        if (!linked || linked.revision !== proposal.value.target.revision) return 'stale-link-revision';
    }
    return '';
}

function previewProposal(data, bucket, proposal) {
    const working = clone(data);
    const metadata = clone(bucket.entries || {});
    return mutateProposal(working, metadata, proposal);
}

function mutateProposal(data, metadata, proposal) {
    if (proposal.operation === 'entry.create') return createEntry(data, metadata, proposal);
    const entry = findNativeEntry(data, proposal.target.uid);
    if (!entry) return failure('missing-entry');
    const key = loreEntryKey(proposal.target);
    const sidecar = metadata[key] || normalizeLivingLoreMetadata({ entryType: proposal.entryType }, proposal.target);
    const beforeContent = String(entry.content || '');
    const diff = [];

    if (proposal.operation === 'fact.append') {
        const section = readSection(beforeContent, 'Established');
        if (hasNormalizedItem(section, proposal.value)) return failure('duplicate-fact');
        entry.content = appendSectionItem(beforeContent, 'Established', proposal.value);
        diff.push(fieldDiff('content.Established', section, readSection(entry.content, 'Established')));
    } else if (proposal.operation === 'current.set') {
        const before = readSection(beforeContent, 'Current');
        entry.content = setSection(beforeContent, 'Current', String(proposal.value).trim());
        diff.push(fieldDiff('content.Current', before, readSection(entry.content, 'Current')));
    } else if (proposal.operation === 'thread.add') {
        const section = readSection(beforeContent, 'Open threads');
        if (hasNormalizedItem(section, proposal.value)) return failure('duplicate-thread');
        entry.content = appendSectionItem(beforeContent, 'Open threads', proposal.value);
        diff.push(fieldDiff('content.Open threads', section, readSection(entry.content, 'Open threads')));
    } else if (proposal.operation === 'alias.add') {
        const before = strings(entry.key);
        if (before.some((item) => normalized(item) === normalized(proposal.value))) return failure('duplicate-alias');
        entry.key = [...before, String(proposal.value).trim()];
        diff.push(fieldDiff('key', before, entry.key));
    } else if (proposal.operation === 'entry.link') {
        const link = normalizeLivingLoreLink(proposal.value);
        if (!link) return failure('invalid-link');
        const before = clone(sidecar.links || []);
        if (before.some((item) => loreEntryKey(item.target) === loreEntryKey(link.target) && item.relation === link.relation)) return failure('duplicate-link');
        sidecar.links = [...before, link];
        diff.push(fieldDiff('links', before, sidecar.links));
    } else if (proposal.operation === 'entry.retire') {
        const before = { disable: Boolean(entry.disable), retirement: readSection(beforeContent, 'Retirement') };
        entry.disable = true;
        entry.content = setSection(beforeContent, 'Retirement', String(proposal.value || proposal.reason).trim());
        diff.push(fieldDiff('retirement', before, { disable: true, retirement: readSection(entry.content, 'Retirement') }));
    } else {
        return failure('unsupported-operation');
    }
    metadata[key] = sidecar;
    return { ok: true, keys: [key], diff: diff.filter((item) => !sameData(item.before, item.after)) };
}

function createEntry(data, metadata, proposal) {
    const uid = nextUid(data.entries);
    const content = setSection('', proposal.section, String(proposal.value).trim());
    const native = {
        uid,
        key: [],
        keysecondary: [],
        comment: entryTitle(proposal.value, proposal.entryType),
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        probability: 100,
        useProbability: true,
    };
    data.entries[uid] = native;
    const ref = { book: proposal.target.book, uid: String(uid) };
    const key = loreEntryKey(ref);
    metadata[key] = normalizeLivingLoreMetadata({ entryType: proposal.entryType, origin: 'loom', revision: 1 }, ref);
    return { ok: true, keys: [key], diff: [fieldDiff('entry', null, clone(native))] };
}

function validateBookLimits(data, keys) {
    for (const key of keys) {
        const entry = findEntryByKey(data, key);
        if (!entry) continue;
        const content = String(entry.content || '');
        if (content.length > MAX_ENTRY_CHARS) return 'entry-too-large';
        if (Math.ceil(content.length / 4) > MAX_ENTRY_TOKENS) return 'entry-token-limit';
    }
    return '';
}

function isProtected(metadata, operation) {
    const protectedFields = new Set(metadata?.protectedFields || []);
    return (PROTECTED_BY_OPERATION[operation] || []).some((field) => protectedFields.has(field));
}

function evidenceSource(evidence, acceptedProse, archiveFacts, promotionFacts = [], explicitInstructions = [], source = {}) {
    const needle = normalized(evidence);
    if (!needle) return '';
    if (normalized(acceptedProse).includes(needle)) return 'accepted-prose';
    // Models naturally shorten a supporting quotation with an ellipsis. It is
    // still grounded when every substantial quoted span occurs, in order, in
    // this exact accepted passage. Do not admit paraphrases: without an
    // explicit ellipsis this remains the strict contiguous-substring check.
    if (matchesElidedEvidence(acceptedProse, evidence)) return 'accepted-prose-elided';
    for (const fact of Array.isArray(archiveFacts) ? archiveFacts : []) {
        const id = String(fact?.id ?? '').trim();
        const summary = typeof fact === 'string' ? fact : String(fact?.summary ?? '');
        if ((id && needle === normalized(`archive:${id}`)) || normalized(summary).includes(needle)) return 'archive';
    }
    for (const fact of Array.isArray(promotionFacts) ? promotionFacts : []) {
        const id = String(fact?.id ?? '').trim();
        const summary = typeof fact === 'string' ? fact : String(fact?.summary ?? '');
        if ((id && needle === normalized(`archive:${id}`)) || normalized(summary).includes(needle)) return 'promotion-candidate';
    }
    if (source?.authority === 'owner' && (Array.isArray(explicitInstructions) ? explicitInstructions : []).some((instruction) => normalized(instruction).includes(needle) || needle.includes(normalized(instruction)))) return 'owner-instruction';
    return '';
}

function matchesElidedEvidence(haystack, evidence) {
    const raw = String(evidence ?? '');
    if (!/[\u2026]|\.{3,}/.test(raw)) return false;
    const spans = raw
        .split(/(?:\u2026|\.{3,})/)
        .map(normalized)
        .filter(Boolean);
    // One tiny fragment on each side would be indistinguishable from a loose
    // keyword match. Require two useful spans and preserve their order.
    if (spans.length < 2 || spans.some((span) => span.length < 12)) return false;
    const text = normalized(haystack);
    let cursor = 0;
    for (const span of spans) {
        const index = text.indexOf(span, cursor);
        if (index < 0) return false;
        cursor = index + span.length;
    }
    return true;
}

function readSection(content, name) {
    return parseContent(content).sections.get(name)?.body || '';
}

function setSection(content, name, body) {
    const parsed = parseContent(content);
    if (!parsed.sections.has(name)) parsed.order.push(name);
    parsed.sections.set(name, { body: String(body || '').trim() });
    return serializeContent(parsed);
}

function appendSectionItem(content, name, value) {
    const before = readSection(content, name);
    const item = `- ${String(value || '').trim()}`;
    return setSection(content, name, [before, item].filter(Boolean).join('\n'));
}

function parseContent(content) {
    const text = String(content || '').replace(/\r\n/g, '\n').trim();
    const pattern = /^(Identity|Established|Current|Open threads|Retirement)\s*$/gmi;
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return { preamble: text, order: [], sections: new Map() };
    const preamble = text.slice(0, matches[0].index).trim();
    const order = [];
    const sections = new Map();
    for (let index = 0; index < matches.length; index += 1) {
        const canonical = SECTION_NAMES.find((name) => name.toLowerCase() === matches[index][1].toLowerCase());
        const start = matches[index].index + matches[index][0].length;
        const end = matches[index + 1]?.index ?? text.length;
        if (!sections.has(canonical)) order.push(canonical);
        sections.set(canonical, { body: text.slice(start, end).trim() });
    }
    return { preamble, order, sections };
}

function serializeContent(parsed) {
    const chunks = [];
    if (parsed.preamble) chunks.push(parsed.preamble);
    for (const name of parsed.order) {
        const body = parsed.sections.get(name)?.body || '';
        chunks.push([name, body].filter(Boolean).join('\n'));
    }
    return chunks.join('\n\n').trim();
}

function findNativeEntry(data, uid) {
    return Object.values(data?.entries || {}).find((entry) => String(entry?.uid) === String(uid)) || null;
}

function findEntryByKey(data, key) {
    const split = String(key).lastIndexOf('.');
    return split < 0 ? null : findNativeEntry(data, String(key).slice(split + 1));
}

function replaceEntryByKey(data, key, value) {
    const existingKey = Object.keys(data.entries || {}).find((entryKey) => String(data.entries[entryKey]?.uid) === String(key).slice(String(key).lastIndexOf('.') + 1));
    if (existingKey != null) delete data.entries[existingKey];
    if (value) data.entries[value.uid] = clone(value);
}

function nextUid(entries) {
    const used = new Set(Object.values(entries || {}).map((entry) => Number(entry?.uid)).filter(Number.isInteger));
    let uid = 0;
    while (used.has(uid)) uid += 1;
    return uid;
}

function entryTitle(value, entryType) {
    const first = String(value || '').trim().split(/\r?\n|(?<=[.!?])\s+/)[0].replace(/^[-*]\s*/, '').trim();
    return (first || `Living Lore ${entryType}`).slice(0, 120);
}

function uniqueProposalId(bucket, preferred) {
    if (!bucket.proposals[preferred]) return preferred;
    let suffix = 2;
    while (bucket.proposals[`${preferred}-${suffix}`]) suffix += 1;
    return `${preferred}-${suffix}`;
}

function fieldDiff(field, before, after) { return { field, before: clone(before), after: clone(after) }; }
function hasNormalizedItem(section, value) {
    const candidate = normalized(value);
    return String(section || '').split(/\r?\n/).map((line) => normalized(line)).some((line) => line === candidate);
}
function normalized(value) { return String(value ?? '').toLowerCase().replace(/^[\s\-*]+|[\s.,;:!?]+$/g, '').replace(/\s+/g, ' ').trim(); }
function uniqueStrings(values) { return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? '').trim()).filter(Boolean))]; }
function strings(values) { return (Array.isArray(values) ? values : []).map((value) => String(value ?? '').trim()).filter(Boolean); }
function sameData(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
function stableHash(value) {
    const text = JSON.stringify(value ?? null);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function clone(value) { return value == null ? value : structuredClone(value); }
function now() { return new Date().toISOString(); }
function makeId(prefix) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`; }
function failure(code, detail = {}) { return { ok: false, code, ...detail }; }
function debug(type, detail, severity = 'info') {
    try {
        recordDebugEvent('world-sense', type, detail, { severity, summary: `Living Lore ${type}` });
    } catch { /* diagnostics cannot break lore transactions */ }
}
