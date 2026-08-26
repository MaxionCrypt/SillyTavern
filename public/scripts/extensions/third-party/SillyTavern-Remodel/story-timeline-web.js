import { getSceneGoals, getTimelineGoalRelations, getTimelineGoals } from './story-goals-store.js';
import { listVariableValues } from './variables-store.js';

const MAX_GOALS = 12;
const MAX_VARIABLES = 12;
const MAX_RELATIONS = 16;

/**
 * Build the bounded, read-only part of the Timeline Web a Story Loom may
 * address. Canonical Goals and Variables stay in their existing stores; this
 * packet is only an address book plus enough meaning to judge consequences.
 */
export function buildStoryTimelineWebPacket({ scene, worldSense = null } = {}) {
    const timelineId = String(scene?.timelineId || '');
    if (!timelineId) return emptyPacket();
    const propagatedGoalIds = new Set((worldSense?.propagation?.goalIds || []).map(String));
    const propagatedVariableIds = new Set((worldSense?.propagation?.variableIds || []).map(String));
    const sceneGoalIds = new Set(getSceneGoals(scene?.id, { includeResolved: true, states: ['active', 'background', 'hidden'] }).map((goal) => goal.id));
    const allGoals = getTimelineGoals(timelineId);
    const goals = prioritized(allGoals, (goal) => propagatedGoalIds.has(goal.id) || sceneGoalIds.has(goal.id), MAX_GOALS)
        .map(projectGoal);
    const variables = prioritized(listVariableValues({ timelineId }), (variable) => propagatedVariableIds.has(variable.id) || variable.retrieval?.mode === 'always', MAX_VARIABLES)
        .map(projectVariable);
    const goalIds = new Set(goals.map((goal) => goal.id));
    const relations = getTimelineGoalRelations(timelineId)
        .filter((relation) => goalIds.has(relation.fromGoalId) && goalIds.has(relation.toGoalId))
        .slice(0, MAX_RELATIONS)
        .map((relation) => ({
            id: relation.id,
            fromGoalId: relation.fromGoalId,
            toGoalId: relation.toGoalId,
            type: relation.type,
            reason: relation.reason,
        }));
    const loreTargets = (worldSense?.loomPacket?.entries || []).map((entry) => ({
        book: String(entry?.target?.book || ''),
        uid: String(entry?.target?.uid ?? ''),
        revision: Number(entry?.target?.revision) || 1,
        name: String(entry?.name || ''),
    })).filter((entry) => entry.book && entry.uid);
    return {
        protocol: 'remodel.timeline-web.story.v1',
        timelineId,
        sceneId: String(scene?.id || ''),
        goals,
        variables,
        relations,
        loreTargets,
        bounds: { maxGoals: MAX_GOALS, maxVariables: MAX_VARIABLES, maxRelations: MAX_RELATIONS },
    };
}

export function formatStoryTimelineWebPacket(packet) {
    if (!packet?.timelineId) return '';
    return [
        'Timeline Web (the only existing Goals, Variables, relations, and lore targets addressable in this retrospective pass):',
        JSON.stringify(packet, null, 2),
        'Use the exact Goal or Variable name as its *Ref. A $alias may address a Goal or Variable created earlier in this same request batch.',
        'Lore attachments may target only loreTargets listed here, copied exactly. This packet is read-only; changes happen only through advertised capabilities.',
    ].join('\n');
}

export function storyTimelineWebAddressing(packet) {
    return {
        goalRefs: new Map((packet?.goals || []).map((goal) => [goal.title, goal.id])),
        variableRefs: new Map((packet?.variables || []).map((variable) => [variable.name, variable.id])),
        loreRefs: new Map((packet?.loreTargets || []).map((target) => [loreKey(target), target.revision])),
    };
}

export function createStoryWebReceipt({ scene, docId, capture, worldSense, webPacket, transaction, lore } = {}) {
    return {
        protocol: 'remodel.timeline-web-receipt.v1',
        id: `story-web:${String(capture?.id || '')}`,
        timelineId: String(scene?.timelineId || ''),
        sceneId: String(scene?.id || ''),
        docId: String(docId || ''),
        captureId: String(capture?.id || ''),
        bodyRevision: capture?.bodyRevision ?? null,
        sourceSpan: capture ? { start: capture.start, end: capture.end } : null,
        contentHash: String(capture?.contentHash || ''),
        worldSenseReceiptId: worldSense?.receipt?.id || null,
        addressed: {
            goalIds: (webPacket?.goals || []).map((goal) => goal.id),
            variableIds: (webPacket?.variables || []).map((variable) => variable.id),
            loreTargets: (webPacket?.loreTargets || []).map((target) => loreKey(target)),
        },
        transactionId: transaction?.id || null,
        mechanics: (transaction?.receipts || []).map((receipt) => ({
            requestId: receipt.requestId || null,
            capability: receipt.capability || '',
            status: receipt.status || '',
            approvalStatus: receipt.approvalStatus || '',
        })),
        loreProposalIds: (lore?.queued || []).map((item) => String(item.id)),
        loreProposalRejections: [...(lore?.rejected || [])],
        createdAt: new Date().toISOString(),
    };
}

function prioritized(records, preferred, limit) {
    return [...records].sort((left, right) => Number(preferred(right)) - Number(preferred(left))).slice(0, limit);
}

function projectGoal(goal) {
    return {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        successRate: goal.successRate,
        status: goal.status,
        visibility: goal.visibility,
        holderRefs: goal.holderRefs || [],
        targetRefs: goal.targetRefs || [],
        loreLinks: goal.loreLinks || [],
    };
}

function projectVariable(variable) {
    return {
        id: variable.id,
        name: variable.name,
        description: variable.description,
        valueType: variable.valueType,
        value: variable.value,
        enumValues: variable.enumValues || [],
        subvalues: variable.subvalues || [],
        authority: variable.authority,
        loreLinks: variable.loreLinks || [],
    };
}

function loreKey(value) {
    const book = String(value?.book || '').trim();
    const uid = String(value?.uid ?? '').trim();
    return book && uid ? `${book}.${uid}` : '';
}

function emptyPacket() {
    return { protocol: 'remodel.timeline-web.story.v1', timelineId: '', sceneId: '', goals: [], variables: [], relations: [], loreTargets: [], bounds: {} };
}
