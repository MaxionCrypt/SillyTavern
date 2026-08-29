import { getContext } from '../../../st-context.js';
import { executeMechanicsRequest, MECHANICS_PROTOCOL } from './mechanics-capabilities.js';
import { buildAddressBook } from './direction-address.js';
import { getTimelineGoals } from './story-goals-store.js';
import { listVariableValues } from './variables-store.js';
import {
    registerArchiveConsequenceSubscriber,
    setArchiveConsequenceSubscriberEnabled,
} from './archive-consequences.js';
import {
    GOAL_LIFECYCLE_CAPABILITIES,
    VARIABLE_LIFECYCLE_CAPABILITIES,
    validateTimelineLifecycleProposal,
} from './timeline-lifecycle-contract.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'timelineLifecycleProjectionV1';
const DEFAULT_SWITCHES = Object.freeze({ goals: true, variables: true });
const LIFECYCLE_PROMPT_MAX_ITEMS = 24;
const LIFECYCLE_PROMPT_MAX_CHARS = 8_000;

export function createTimelineLifecycleProjector({
    execute = executeMechanicsRequest,
    goals = getTimelineGoals,
    variables = ({ timelineId }) => listVariableValues({ timelineId }),
} = {}) {
    return Object.freeze({
        project(channel, event) {
            const proposals = (event?.evidence?.lifecycleProposals || []).filter((proposal) => channelCapabilities(channel).includes(proposal?.capability));
            const accepted = [];
            const rejected = [];
            for (const proposal of proposals) {
                const validation = validateTimelineLifecycleProposal(proposal, channel);
                if (!validation.ok) {
                    rejected.push({ requestId: String(proposal?.id || ''), capability: String(proposal?.capability || ''), code: validation.code, message: validation.message });
                    continue;
                }
                accepted.push(withEvidenceProvenance(validation.request, event));
            }
            if (!accepted.length) return projectionReceipt(channel, event, null, rejected);
            const goalBook = buildAddressBook(goals(event.timelineId).map((goal) => ({ id: goal.id, name: goal.title })));
            const variableBook = buildAddressBook(variables({ timelineId: event.timelineId }).map((variable) => ({ id: variable.id, name: variable.name })));
            const result = execute({ protocol: MECHANICS_PROTOCOL, requests: accepted }, {
                timelineId: event.timelineId,
                sceneId: event.sceneId,
                turnId: event.provenance?.sourceId,
                directionId: `${event.eventId}:${channel}`,
                messageId: event.provenance?.messageId,
                checkpointId: event.eventId,
                goalRefs: new Map(goalBook.entries.map((entry) => [entry.name, entry.id])),
                variableRefs: new Map(variableBook.entries.map((entry) => [entry.name, entry.id])),
                retrievedVariableIds: variableBook.entries.map((entry) => entry.id),
                authorizedGoalIds: [],
                authorizedVariableRefs: [],
                allowUserGoalCreate: false,
                source: {
                    kind: 'archive-lifecycle-projection',
                    channel,
                    eventId: event.eventId,
                    archiveJobId: event.jobId,
                    archiveTransactionId: event.baseArchive?.transactionId || null,
                    evidenceHash: hashText(event.evidence?.acceptedProse || ''),
                },
            });
            return projectionReceipt(channel, event, result, rejected);
        },
    });
}

export function getTimelineLifecycleProjectionSwitches() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const current = context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
    if (!current || typeof current !== 'object') {
        context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = { ...DEFAULT_SWITCHES };
    }
    const stored = context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
    return { goals: stored.goals !== false, variables: stored.variables !== false };
}

/** Give the Archive observer the exact lifecycle addresses it is allowed to
 * propose against. Archive prose alone can mention an outcome without proving
 * that a real Goal object exists; omitting this board made models either guess
 * a goalRef or skip a warranted closure altogether. */
export function buildTimelineLifecyclePromptContext(timelineId, switches = getTimelineLifecycleProjectionSwitches()) {
    const sections = [];
    if (switches.goals) {
        const openGoals = getTimelineGoals(String(timelineId || ''))
            .filter((goal) => !['achieved', 'abandoned', 'impossible'].includes(String(goal?.status || '').toLowerCase()))
            .slice(0, LIFECYCLE_PROMPT_MAX_ITEMS);
        sections.push(openGoals.length
            ? ['GOALS — address goal.edit and goal.relate by the exact goalRef shown:', ...openGoals.map((goal) => {
                const holders = (goal.holderRefs || []).map((holder) => holder.label || holder.id).filter(Boolean).join(', ');
                return `- goalRef ${JSON.stringify(String(goal.title || ''))} · status ${String(goal.status || 'active')} · holders ${holders || 'unspecified'}\n  ${String(goal.description || '').trim() || '[no description]'}`;
            })].join('\n')
            : 'GOALS — none currently open.');
    }
    if (switches.variables) {
        const existing = listVariableValues({ timelineId: String(timelineId || '') }).slice(0, LIFECYCLE_PROMPT_MAX_ITEMS);
        sections.push(existing.length
            ? ['VARIABLES — these names already exist; variable.create must not duplicate them:', ...existing.map((variable) => `- ${JSON.stringify(String(variable.name || ''))}: ${String(variable.description || '').trim() || '[no description]'}`)].join('\n')
            : 'VARIABLES — none currently exist.');
    }
    const text = sections.length ? `[EXISTING TIMELINE LIFECYCLE — exact addresses]\n${sections.join('\n\n')}` : '';
    return text.length > LIFECYCLE_PROMPT_MAX_CHARS ? `${text.slice(0, LIFECYCLE_PROMPT_MAX_CHARS)}\n[bounded]` : text;
}

export function setTimelineLifecycleProjectionSwitch(channel, value) {
    if (!['goals', 'variables'].includes(channel)) throw new TypeError(`Unknown lifecycle projection switch: ${channel}.`);
    const context = getContext();
    const switches = getTimelineLifecycleProjectionSwitches();
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = { ...switches, [channel]: value === true };
    setArchiveConsequenceSubscriberEnabled(channel, value === true);
    context.saveSettingsDebounced?.();
    return getTimelineLifecycleProjectionSwitches();
}

let registered = false;
export function ensureTimelineLifecycleProjectionRegistered() {
    if (registered) return;
    registered = true;
    const projector = createTimelineLifecycleProjector();
    const switches = getTimelineLifecycleProjectionSwitches();
    registerArchiveConsequenceSubscriber('goals', (event) => projector.project('goals', event), { enabled: switches.goals });
    registerArchiveConsequenceSubscriber('variables', (event) => projector.project('variables', event), { enabled: switches.variables });
}

function projectionReceipt(channel, event, result, rejected) {
    const transaction = result?.transaction || null;
    return {
        protocol: 'remodel/timeline-lifecycle/1',
        channel,
        eventId: String(event?.eventId || ''),
        status: result ? (result.ok ? transaction?.status || 'applied' : 'rolled-back') : rejected.length ? 'rejected' : 'no-op',
        transactionId: transaction?.id || null,
        applied: result?.receipts?.filter((receipt) => receipt.status === 'applied').length || 0,
        pendingReview: Number(result?.pending || 0),
        rejected,
        rollback: transaction?.id && result?.ok
            ? { kind: 'mechanics-transaction', transactionId: transaction.id, ownsBaseArchive: false }
            : null,
    };
}

function withEvidenceProvenance(request, event) {
    const copy = JSON.parse(JSON.stringify(request));
    copy.arguments._archiveEvidence = {
        eventId: event.eventId,
        jobId: event.jobId,
        sourceId: String(event.provenance?.sourceId || ''),
        archiveTransactionId: event.baseArchive?.transactionId || null,
        acceptedProseHash: hashText(event.evidence?.acceptedProse || ''),
    };
    return copy;
}

function channelCapabilities(channel) {
    if (channel === 'goals') return GOAL_LIFECYCLE_CAPABILITIES;
    if (channel === 'variables') return VARIABLE_LIFECYCLE_CAPABILITIES;
    return [];
}

function hashText(value) {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(String(value || ''))) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
