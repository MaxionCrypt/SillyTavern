import { selectTimelineLifecycleProposals } from './timeline-lifecycle-contract.js';

export const ARCHIVE_INGESTION_PROTOCOL = 'remodel-archive-ingestion/1';
export const ARCHIVE_STATE_MAX_CHARS = 16_000;
export const ARCHIVE_ACTION_MAX_CHARS = 4_000;

export const ARCHIVE_CAPABILITY_NAMES = Object.freeze([
    'scene.set', 'scene.clear', 'event.record',
    'char_state.set', 'char_state.clear', 'beat.set',
    'secret.set', 'secret.clear',
]);

const ARCHIVE_CAPABILITY_SET = new Set(ARCHIVE_CAPABILITY_NAMES);
const FORBIDDEN_OUTPUT_KEYS = Object.freeze([
    'prose', 'committedProse', 'swaps', 'flow', 'loreProposals',
    'goals', 'variables', 'sceneCouncil',
]);

/** Closed port for Archive-only ingestion implementations. */
export function createArchiveIngestion(adapter = {}) {
    if (typeof adapter.ingest !== 'function') {
        throw new TypeError('Archive ingestion requires an ingest implementation.');
    }
    return Object.freeze({
        async ingest(input) {
            const request = normalizeArchiveIngestionInput(input);
            const output = await adapter.ingest(request);
            return normalizeArchiveIngestionOutput(output, request);
        },
    });
}

export function normalizeArchiveIngestionInput(input = {}) {
    const acceptedProse = String(input.acceptedProse || '').trim();
    if (!acceptedProse) throw new Error('Archive ingestion requires accepted prose.');
    const mode = input.mode === 'story' ? 'story' : input.mode === 'roleplay' ? 'roleplay' : '';
    if (!mode) throw new Error('Archive ingestion requires Story or Roleplay provenance.');
    const timelineId = String(input.timelineId || '').trim();
    const sceneId = String(input.sceneId || '').trim();
    if (!timelineId || !sceneId) throw new Error('Archive ingestion requires Timeline and Scene identity.');
    return immutable({
        protocol: ARCHIVE_INGESTION_PROTOCOL,
        jobId: String(input.jobId || '').trim() || `${mode}:${sceneId}`,
        mode,
        timelineId,
        sceneId,
        acceptedProse,
        statePacket: normalizeStatePacket(input.statePacket),
        // Candidate output belongs to the legacy adapter only. It is snapped
        // beside the request so later mutation of a streamed buffer cannot
        // change what this ingestion attempt validates.
        candidateReply: String(input.candidateReply || ''),
    });
}

export function isArchiveCapability(name) {
    return ARCHIVE_CAPABILITY_SET.has(String(name || ''));
}

export function selectArchiveOperations(requests) {
    return (Array.isArray(requests) ? requests : [])
        .filter((request) => isArchiveCapability(request?.capability))
        .map((request) => structuredClone(request));
}

export function archiveEvidenceFromOperations(requests, { mode = 'roleplay' } = {}) {
    if (mode === 'story') {
        const values = [];
        for (const request of selectArchiveOperations(requests)) {
            const args = request?.arguments || {};
            switch (request?.capability) {
                case 'event.record': values.push(args.summary); break;
                case 'scene.set': values.push(`${args.key}: ${args.value}`); break;
                case 'scene.clear': values.push(`${args.key}: cleared`); break;
                case 'char_state.set': values.push(`${args.charId} ${args.facet}: ${args.value}`); break;
                case 'char_state.clear': values.push(`${args.charId} ${args.facet}: cleared`); break;
                case 'beat.set': values.push(args.directive); break;
                default: break;
            }
        }
        return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
    }
    const facts = [];
    for (const request of selectArchiveOperations(requests)) {
        const args = request.arguments || {};
        for (const value of [args.summary, args.value, args.directive]) {
            const text = String(value || '').trim();
            if (text) facts.push(text);
        }
    }
    return facts;
}

function normalizeArchiveIngestionOutput(output, request) {
    const value = output && typeof output === 'object' ? output : {};
    for (const key of FORBIDDEN_OUTPUT_KEYS) {
        if (key in value) throw new Error(`Archive ingestion cannot return ${key}.`);
    }
    const operations = selectArchiveOperations(value.operations);
    if (operations.length !== (Array.isArray(value.operations) ? value.operations.length : 0)) {
        throw new Error('Archive ingestion returned an operation outside the Archive capability boundary.');
    }
    const lifecycleProposals = selectTimelineLifecycleProposals(value.lifecycleProposals);
    if (lifecycleProposals.length !== (Array.isArray(value.lifecycleProposals) ? value.lifecycleProposals.length : 0)) {
        throw new Error('Archive ingestion returned a proposal outside the Timeline lifecycle boundary.');
    }
    return immutable({
        protocol: ARCHIVE_INGESTION_PROTOCOL,
        jobId: request.jobId,
        mode: request.mode,
        timelineId: request.timelineId,
        sceneId: request.sceneId,
        operations,
        lifecycleProposals,
        archiveFacts: archiveEvidenceFromOperations(operations, { mode: request.mode }),
        rejected: Array.isArray(value.rejected) ? structuredClone(value.rejected) : [],
        receipt: value.receipt && typeof value.receipt === 'object' ? structuredClone(value.receipt) : {},
    });
}

function normalizeStatePacket(value) {
    const packet = value && typeof value === 'object' ? value : {};
    return {
        sourceId: String(packet.sourceId || '').trim(),
        documentId: String(packet.documentId || '').trim(),
        messageId: packet.messageId == null ? null : String(packet.messageId),
        checkpointId: String(packet.checkpointId || '').trim(),
        reason: String(packet.reason || '').trim(),
        interrupted: Boolean(packet.interrupted),
        archiveState: tail(packet.archiveState, ARCHIVE_STATE_MAX_CHARS),
        currentPlayerAction: tail(packet.currentPlayerAction, ARCHIVE_ACTION_MAX_CHARS),
    };
}

function tail(value, limit) {
    const text = String(value || '');
    return text.length > limit ? text.slice(-limit) : text;
}

function immutable(value) {
    return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}
