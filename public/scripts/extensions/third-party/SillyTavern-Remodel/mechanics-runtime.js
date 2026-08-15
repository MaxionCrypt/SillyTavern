import { extension_prompt_roles, extension_prompt_types, main_api, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { executeMechanicsRequest, getCapabilityDictionary, getMechanicsRequestSchema, MECHANICS_PROTOCOL, toCoreJsonSchema } from './mechanics-capabilities.js';
import { getSceneGoals, getSceneGoalRelations, nextStoryGoalTurn } from './story-goals-store.js';
import { interpretStructuredReply, structuredResponseLength } from './structured-reply.js';
import { getMechanicsProfile } from './variables-store.js';
import { resolveVariableContext } from './variables-context.js';

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
        { role: 'user', content: `MECHANICAL SNAPSHOT\n${JSON.stringify(snapshot)}\n\nReturn one ${MECHANICS_PROTOCOL} envelope. Return an empty requests array when no authoritative fact changes.` },
    ];
    const raw = await getContext().generateRaw({
        api: 'openai', prompt,
        responseLength: structuredResponseLength(profile.contextBudget, { divisor: 4, ceiling: 2048 }),
        instructOverride: false, jsonSchema: toCoreJsonSchema(getMechanicsRequestSchema()),
    });
    const envelope = interpretStructuredReply(raw, 'Mechanical AI');
    const result = executeMechanicsRequest(envelope, {
        timelineId: scene.timelineId, sceneId: scene.id, turnId,
        authorizedGoalIds, authorizedVariableRefs: [], variableRefs: snapshot.variableRefs,
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
    });
    const variables = resolved.listed.map(({ ref, variable, reasons }) => ({
        ref, name: variable.name, description: variable.description,
        type: variable.valueType, value: variable.value,
        subvalues: variable.subvalues.map(({ key, label, type, value, role }) => ({ key, label, type, value, role })),
        modifiers: variable.modifiers.map(({ label, amount, target, reason }) => ({ label, amount, target, reason })),
        authority: variable.authority, reason: reasons.join(' '),
    }));
    return {
        timelineId: scene.timelineId, sceneId: scene.id, action: String(action),
        explicitlyAuthorizedGoalIds: authorizedGoalIds.map(String),
        entities: subjects,
        goals: goals.map((goal) => ({ id: goal.id, title: goal.title, description: goal.description, holderRefs: goal.holderRefs, targetRefs: goal.targetRefs, successRate: goal.successRate, resolution: goal.resolution, status: goal.status, visibility: goal.visibility })),
        relationships: getSceneGoalRelations(scene.id),
        addressBook: variables.map((item) => `[${item.ref}] ${item.name} = ${String(item.value)}`),
        variables,
        // Maps stringify as {}, so persistent IDs remain code-side only.
        variableRefs: resolved.refToId,
        retrieval: { degraded: resolved.degraded, warning: resolved.vectorError, selected: variables.length, diagnostics: resolved.diagnostics.filter((item) => item.included) },
    };
}

export function mechanicalHandbook(additions) {
    return `You are the hidden mechanical adjudicator for a continuous roleplay. Goals and Variables are persistent memory, not a turn structure. Never narrate, invent references, emit dice, or mutate state directly. Submit only advertised capabilities using the temporary v1, v2... references in the current address book. Code owns validation, bounds, authority, transactions, and any roll.\n\nVARIABLES\nLorebook prose supplies meaning. Variables supply authoritative current scalar facts. Use variable.set for an exact correction, variable.adjust for numeric change, variable.transition for enum change, and variable.subvalue.set only for an advertised field. Do not request a Variable that is absent from the temporary address book.\n\nAUTHORITY\nUser/persona state requires direct authorization or review. Bounded world state may apply automatically.\n${String(additions || '').trim()}`;
}

export function formatMechanicsReceipts(receipts) {
    if (!Array.isArray(receipts) || !receipts.length) return '';
    return `[Authoritative mechanical receipts. Do not reroll or contradict.]\n${receipts.map((receipt) => `- ${receipt.capability}: ${receipt.reason}.`).join('\n')}`;
}
