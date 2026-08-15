import { extension_prompt_roles, extension_prompt_types, main_api, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { executeMechanicsRequest, getCapabilityDictionary, getMechanicsRequestSchema, MECHANICS_PROTOCOL, toCoreJsonSchema } from './mechanics-capabilities.js';
import { getSceneGoals, getSceneGoalRelations, nextStoryGoalTurn } from './story-goals-store.js';
import { interpretStructuredReply, structuredResponseLength } from './structured-reply.js';
import { getMechanicsProfile } from './variables-store.js';
import { resolveVariableContext } from './variables-context.js';
import { buildAddressBook } from './direction-address.js';

const RECEIPT_PROMPT_KEY = 'remodel_mechanics_receipts';
let pendingReceipt = null;

export function canRunAutomaticMechanics() {
    return getMechanicsProfile().enabled && main_api === 'openai';
}

export async function runMechanicalPreflight({ scene, action, cast = [], persona = null, authorizedGoalIds = [] } = {}) {
    if (!scene?.timelineId || !String(action || '').trim()) return { skipped: true, reason: 'No mechanical action.' };
    const profile = getMechanicsProfile();
    if (!profile.enabled) return { skipped: true, reason: 'Mechanics are disabled for this account.' };
    if (main_api !== 'openai') throw new Error('Automatic mechanics require the current Chat Completion connection.');
    const turnId = nextStoryGoalTurn(scene.id, { timelineId: scene.timelineId });
    const snapshot = await buildMechanicalSnapshot(scene, action, cast, persona, authorizedGoalIds);
    const prompt = [
        { role: 'system', content: mechanicalHandbook(profile.handbookAdditions) },
        { role: 'system', content: `CAPABILITY DICTIONARY\n${JSON.stringify(getCapabilityDictionary())}` },
        { role: 'user', content: `MECHANICAL SNAPSHOT\n${formatMechanicalSnapshot(snapshot)}\n\nReturn one ${MECHANICS_PROTOCOL} envelope. Return an empty requests array when no authoritative fact changes.` },
    ];
    const raw = await getContext().generateRaw({
        api: 'openai', prompt,
        responseLength: structuredResponseLength(profile.contextBudget, { divisor: 4, ceiling: 2048 }),
        instructOverride: false, jsonSchema: toCoreJsonSchema(getMechanicsRequestSchema()),
    });
    const envelope = interpretStructuredReply(raw, 'Mechanical AI');
    const result = executeMechanicsRequest(envelope, {
        timelineId: scene.timelineId, sceneId: scene.id, turnId,
        authorizedGoalIds, authorizedVariableRefs: [],
        variableRefs: snapshot.variableRefs, goalRefs: snapshot.goalRefs,
        allowUserGoalCreate: false,
    });
    if (!result.ok) throw new Error(result.errors?.join(' ') || 'The mechanical transaction was rejected.');
    return { ...result, turnId, snapshot };
}

export function prepareMechanicsReceiptInjection(scene, result) {
    const applied = (result?.receipts || []).filter((receipt) => receipt.status === 'applied');
    if (!applied.length) return false;
    const content = formatMechanicsReceipts(applied);
    pendingReceipt = { sceneId: scene.id, transactionId: result.transaction?.id || '', content };
    setExtensionPrompt(RECEIPT_PROMPT_KEY, content, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM, () => pendingReceipt?.sceneId === scene.id);
    return true;
}

export function clearMechanicsReceiptInjection() {
    pendingReceipt = null;
    setExtensionPrompt(RECEIPT_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
}

export async function previewMechanicalContext(scene, { cast = [], persona = null } = {}) {
    return buildMechanicalSnapshot(scene, '[preview only: retrieve state; do not mutate or roll]', cast, persona);
}

export async function buildMechanicalSnapshot(scene, action, cast = [], persona = null, authorizedGoalIds = [], evidence = {}) {
    const goals = getSceneGoals(scene.id, { includeResolved: false, states: ['active', 'background'] });
    const subjects = [persona, ...cast].filter(Boolean);
    const resolved = await resolveVariableContext({
        timelineId: scene.timelineId, action,
        history: evidence.history || [], cast: subjects,
        activatedEntries: evidence.activatedEntries || [], goals,
        correlationId: evidence.correlationId || null,
    });

    // Goals get temporary refs for the same reason Variables do: a persistent
    // UUID in the prompt is one the model can echo back for a Goal that was
    // never advertised this pass. g1/g2 are meaningless outside this request.
    const goalRefs = new Map();
    const listedGoals = goals.map((goal, index) => {
        const ref = `g${index + 1}`;
        goalRefs.set(ref, goal.id);
        return {
            ref, title: goal.title, description: goal.description,
            holderRefs: goal.holderRefs, targetRefs: goal.targetRefs,
            successRate: goal.successRate, status: goal.status, visibility: goal.visibility,
            resolution: describeResolution(goal.resolution, resolved.refToId),
        };
    });
    const refByGoalId = new Map([...goalRefs].map(([ref, id]) => [id, ref]));

    // The address book lets the Director name a Variable or Goal directly —
    // see direction-address.js. Built only from what this pass actually
    // advertised: the Variables retrieval selected (resolved.listed), not
    // every Variable in the Timeline, and the Goals just listed above.
    const addressBook = buildAddressBook([
        ...resolved.listed.map((item) => ({ id: item.variable.id, name: item.variable.name })),
        ...goals.map((goal) => ({ id: goal.id, name: goal.title })),
    ]);

    return {
        timelineId: scene.timelineId, sceneId: scene.id, action: String(action),
        authorizedGoalRefs: authorizedGoalIds.map((id) => refByGoalId.get(String(id))).filter(Boolean),
        entities: subjects,
        goals: listedGoals,
        relationships: describeRelations(getSceneGoalRelations(scene.id), refByGoalId),
        // Variables travel as compact lines rather than inside the JSON — see
        // formatMechanicalSnapshot. Held here so callers need one object.
        serializedVariables: resolved.serialized,
        addressBook,
        // The operations a Director may request, carried in the snapshot so
        // direction-sources.js can render them without importing
        // mechanics-capabilities.js itself — that module pulls in
        // variables-store.js/story-goals-store.js, which import st-context.js,
        // and direction-sources.js is required to stay free of that.
        capabilities: getCapabilityDictionary(),
        // Maps stringify as {}, so persistent IDs remain code-side only.
        variableRefs: resolved.refToId,
        goalRefs,
        // Only the shape of retrieval, never its rejects: naming the Variables
        // that deliberately did not surface would hand the model the context
        // retrieval just decided to withhold. Full diagnostics go to the journal.
        retrieval: { degraded: resolved.degraded, warning: resolved.vectorError, selected: resolved.listed.length },
    };
}

/** A tracked resolution names its Variable by this request's ref, or not at all. */
function describeResolution(resolution, variableRefs) {
    if (!resolution || resolution.kind !== 'tracked') return { kind: 'instant' };
    const ref = [...variableRefs].find(([, id]) => id === resolution.variableId)?.[0] || '';
    return {
        kind: 'tracked', variableRef: ref, field: resolution.field,
        direction: resolution.direction, completionThreshold: resolution.completionThreshold,
        ...(ref ? {} : { note: 'Its tracked Variable was not retrieved this pass.' }),
    };
}

function describeRelations(relations, refByGoalId) {
    return (relations || []).map((relation) => ({
        ...relation,
        fromRef: refByGoalId.get(String(relation.fromGoalId ?? relation.goalId ?? '')) || '',
        toRef: refByGoalId.get(String(relation.toGoalId ?? relation.relatedGoalId ?? '')) || '',
        fromGoalId: undefined, toGoalId: undefined, goalId: undefined, relatedGoalId: undefined,
    }));
}

/**
 * Render a snapshot for a prompt.
 *
 * Variables leave the JSON and arrive as the compact lines
 * `serializeRetrievedVariables` produces — the format the design specifies, and
 * far cheaper than a nested object per Variable. The Maps carrying persistent
 * IDs are dropped rather than relied on stringifying to `{}`.
 */
export function formatMechanicalSnapshot(snapshot) {
    const { serializedVariables, variableRefs, goalRefs, ...rest } = snapshot;
    return `${JSON.stringify(rest)}\n\nVARIABLES\n${serializedVariables || 'No relevant Variables were retrieved.'}`;
}

export function mechanicalHandbook(additions) {
    return `You are the hidden mechanical adjudicator for a continuous roleplay. Goals and Variables are persistent memory, not a turn structure. Never narrate, invent references, emit dice, or mutate state directly. Submit only advertised capabilities, addressing Variables by their temporary v1, v2... references and Goals by their temporary g1, g2... references from the current snapshot. Those references are valid only for this request; a reference you were not given this time will be rejected. Code owns validation, bounds, authority, transactions, and any roll.\n\nVARIABLES\nLorebook prose supplies meaning. Variables supply authoritative current scalar facts. Use variable.set for an exact correction, variable.adjust for numeric change, variable.transition for enum change, and variable.subvalue.set only for an advertised field. Do not request a Variable that is absent from the temporary address book.\n\nAUTHORITY\nUser/persona state requires direct authorization or review. Bounded world state may apply automatically.\n${String(additions || '').trim()}`;
}

export function formatMechanicsReceipts(receipts) {
    if (!Array.isArray(receipts) || !receipts.length) return '';
    return `[Authoritative mechanical receipts. Do not reroll or contradict.]\n${receipts.map((receipt) => `- ${receipt.capability}: ${receipt.reason}.`).join('\n')}`;
}
